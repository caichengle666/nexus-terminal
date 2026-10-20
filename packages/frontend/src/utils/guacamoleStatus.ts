/**
 * Guacamole 客户端状态 → i18n 键。
 * 使用字面量键 (而不是 `remoteDesktopModal.status.${part}` 拼接)，
 * 让 i18n 键检查 / 搜索工具能看到实际使用的键，未知状态回落到 unknownState。
 */
const GUAC_STATUS_KEYS = {
  idle: 'remoteDesktopModal.status.idle',
  connectingRdp: 'remoteDesktopModal.status.connectingRdp',
  connectingVnc: 'remoteDesktopModal.status.connectingVnc',
  waiting: 'remoteDesktopModal.status.waiting',
  connected: 'remoteDesktopModal.status.connected',
  disconnecting: 'remoteDesktopModal.status.disconnecting',
  disconnected: 'remoteDesktopModal.status.disconnected',
  unknownState: 'remoteDesktopModal.status.unknownState',
} as const;

export type GuacStatusPart = keyof typeof GUAC_STATUS_KEYS;

export const guacStatusKey = (part: string): string =>
  GUAC_STATUS_KEYS[part as GuacStatusPart] ?? GUAC_STATUS_KEYS.unknownState;
