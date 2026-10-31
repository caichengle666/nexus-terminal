/**
 * Pure helpers for the AI model profile list stored in the `aiTerminalConfig` setting.
 * Kept free of DB / crypto imports so they can be unit tested.
 *
 * Stored shape (version 2):
 *   { version: 2, activeProfileId, customSystemPrompt, profiles: [{ id, name, apiBaseUrl, model, encryptedApiKey, streamUsageUnsupported? }] }
 *
 * The legacy single-config shape { apiBaseUrl, model, encryptedApiKey, customSystemPrompt } is read
 * transparently as one profile named "默认" (id "default"); it is only rewritten in the new shape
 * on the next save. Encrypted keys never leave the backend: the client view only carries hasApiKey.
 */
import { randomBytes } from 'crypto';
import { AiConfigValidationError } from './ai-config.validation';

export const DEFAULT_AI_PROFILE_ID = 'default';
export const DEFAULT_AI_PROFILE_NAME = '默认';
export const MAX_AI_PROFILES = 20;
export const MAX_AI_PROFILE_NAME_LENGTH = 64;

export interface StoredAiProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  model: string;
  encryptedApiKey: string;
  /** Set once the provider rejected `stream_options.include_usage`; streaming then omits it. */
  streamUsageUnsupported?: boolean;
}

export interface StoredAiConfig {
  version: 2;
  activeProfileId: string;
  customSystemPrompt: string;
  profiles: StoredAiProfile[];
}

export interface ClientAiProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  model: string;
  hasApiKey: boolean;
}

export interface ClientAiConfig {
  activeProfileId: string;
  customSystemPrompt: string;
  profiles: ClientAiProfile[];
  /** Legacy fields mirroring the active profile (older frontends read these). */
  apiBaseUrl: string;
  model: string;
  hasApiKey: boolean;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const PROFILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidProfileId = (value: unknown): value is string => typeof value === 'string' && PROFILE_ID_RE.test(value);

export const createProfileId = () => `p_${randomBytes(6).toString('hex')}`;

const emptyProfile = (overrides: Partial<StoredAiProfile> = {}): StoredAiProfile => ({
  id: DEFAULT_AI_PROFILE_ID,
  name: DEFAULT_AI_PROFILE_NAME,
  apiBaseUrl: '',
  model: '',
  encryptedApiKey: '',
  ...overrides,
});

const sanitizeProfile = (value: unknown): StoredAiProfile | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!isValidProfileId(item.id)) return null;
  const name = str(item.name).trim().slice(0, MAX_AI_PROFILE_NAME_LENGTH) || item.id;
  return {
    id: item.id,
    name,
    apiBaseUrl: str(item.apiBaseUrl),
    model: str(item.model),
    encryptedApiKey: str(item.encryptedApiKey),
    ...(item.streamUsageUnsupported === true ? { streamUsageUnsupported: true } : {}),
  };
};

/** Parse (and migrate) the raw `aiTerminalConfig` setting. Never throws. */
export const parseStoredAiConfig = (raw: string | null | undefined): StoredAiConfig => {
  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
    } catch {
      parsed = {};
    }
  }

  const customSystemPrompt = str(parsed.customSystemPrompt);

  if (!Array.isArray(parsed.profiles)) {
    // Legacy single config (or nothing stored yet): one default profile.
    return {
      version: 2,
      activeProfileId: DEFAULT_AI_PROFILE_ID,
      customSystemPrompt,
      profiles: [emptyProfile({
        apiBaseUrl: str(parsed.apiBaseUrl),
        model: str(parsed.model),
        encryptedApiKey: str(parsed.encryptedApiKey),
      })],
    };
  }

  const seen = new Set<string>();
  const profiles: StoredAiProfile[] = [];
  for (const entry of parsed.profiles) {
    const profile = sanitizeProfile(entry);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
    if (profiles.length >= MAX_AI_PROFILES) break;
  }
  if (profiles.length === 0) profiles.push(emptyProfile());
  const activeProfileId = typeof parsed.activeProfileId === 'string' && seen.has(parsed.activeProfileId)
    ? parsed.activeProfileId
    : profiles[0].id;
  return { version: 2, activeProfileId, customSystemPrompt, profiles };
};

export const serializeAiConfig = (config: StoredAiConfig) => JSON.stringify({
  version: 2,
  activeProfileId: config.activeProfileId,
  customSystemPrompt: config.customSystemPrompt,
  profiles: config.profiles,
});

/** Profile by id, or the active profile when no id is given. Throws 404 for an unknown id. */
export const findProfile = (config: StoredAiConfig, profileId?: unknown): StoredAiProfile => {
  if (profileId !== undefined && profileId !== null && profileId !== '') {
    const match = config.profiles.find(profile => profile.id === profileId);
    if (!match) throw new AiConfigValidationError('AI 模型配置不存在，可能已被删除。', 404);
    return match;
  }
  return config.profiles.find(profile => profile.id === config.activeProfileId) || config.profiles[0];
};

export const normalizeProfileName = (value: unknown, fallback: string) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new AiConfigValidationError('AI 模型配置名称无效。');
  const name = value.trim();
  if (!name) throw new AiConfigValidationError('AI 模型配置名称不能为空。');
  if (name.length > MAX_AI_PROFILE_NAME_LENGTH) {
    throw new AiConfigValidationError(`AI 模型配置名称不能超过 ${MAX_AI_PROFILE_NAME_LENGTH} 个字符。`);
  }
  return name;
};

export const toClientConfig = (config: StoredAiConfig): ClientAiConfig => {
  const active = findProfile(config);
  return {
    activeProfileId: active.id,
    customSystemPrompt: config.customSystemPrompt,
    profiles: config.profiles.map(profile => ({
      id: profile.id,
      name: profile.name,
      apiBaseUrl: profile.apiBaseUrl,
      model: profile.model,
      hasApiKey: !!profile.encryptedApiKey,
    })),
    apiBaseUrl: active.apiBaseUrl,
    model: active.model,
    hasApiKey: !!active.encryptedApiKey,
  };
};

/** Add a profile (returns a new config object). Throws when the limit is reached. */
export const addProfile = (config: StoredAiConfig, profile: StoredAiProfile, activate = false): StoredAiConfig => {
  if (config.profiles.length >= MAX_AI_PROFILES) {
    throw new AiConfigValidationError(`最多只能保存 ${MAX_AI_PROFILES} 个 AI 模型配置。`);
  }
  if (config.profiles.some(item => item.id === profile.id)) {
    throw new AiConfigValidationError('AI 模型配置 ID 重复。');
  }
  return {
    ...config,
    profiles: [...config.profiles, profile],
    activeProfileId: activate ? profile.id : config.activeProfileId,
  };
};

/** Remove a profile (returns a new config object). The last profile can not be removed. */
export const removeProfile = (config: StoredAiConfig, profileId: unknown): StoredAiConfig => {
  const target = findProfile(config, profileId);
  if (config.profiles.length <= 1) {
    throw new AiConfigValidationError('至少需要保留一个 AI 模型配置。');
  }
  const profiles = config.profiles.filter(profile => profile.id !== target.id);
  return {
    ...config,
    profiles,
    activeProfileId: config.activeProfileId === target.id ? profiles[0].id : config.activeProfileId,
  };
};

export const setActiveProfile = (config: StoredAiConfig, profileId: unknown): StoredAiConfig => {
  const target = findProfile(config, profileId);
  return { ...config, activeProfileId: target.id };
};

/** Replace one profile in the list (returns a new config object). */
export const replaceProfile = (config: StoredAiConfig, profile: StoredAiProfile): StoredAiConfig => ({
  ...config,
  profiles: config.profiles.map(item => (item.id === profile.id ? profile : item)),
});
