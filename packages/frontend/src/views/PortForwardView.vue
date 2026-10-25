<template>
  <div class="pf-root flex flex-col h-full min-h-0 text-foreground">
    <!-- 头部：标题 + 当前连接 + 新增 -->
    <div class="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b border-border">
      <div class="flex items-center gap-2 min-w-0">
        <i class="fas fa-arrow-right-arrow-left text-sm"></i>
        <span class="text-sm font-semibold truncate">{{ t('portForward.title', '端口转发') }}</span>
        <span v-if="connectionId && activeConnectionName" class="text-xs text-text-secondary truncate">· {{ activeConnectionName }}</span>
      </div>
      <button
        type="button"
        class="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-md text-text-secondary hover:text-primary hover:bg-hover transition-colors disabled:opacity-40 disabled:pointer-events-none pf-ibtn"
        :disabled="!connectionId || desktopOnly"
        @click="openEditor()"
        :title="t('portForward.add', '新建规则')"
        :aria-label="t('portForward.add', '新建规则')"
      >
        <i class="fas fa-plus text-xs"></i>
      </button>
    </div>

    <!-- 后端不在桌面模式（理论上 web 端不会显示本面板，兜底） -->
    <div v-if="desktopOnly" class="flex-grow flex flex-col items-center justify-center gap-2 text-text-secondary px-4 text-center">
      <i class="fas fa-desktop text-2xl opacity-60"></i>
      <span class="text-xs">{{ t('portForward.desktopOnly', '端口转发仅在桌面端可用') }}</span>
    </div>

    <!-- 没有活动连接 -->
    <div v-else-if="!connectionId" class="flex-grow flex flex-col items-center justify-center gap-2 text-text-secondary px-4 text-center">
      <i class="fas fa-plug-circle-xmark text-2xl opacity-60"></i>
      <span class="text-xs">{{ t('portForward.noSession', '先打开一个 SSH 会话') }}</span>
    </div>

    <!-- 规则列表 -->
    <div v-else class="flex-grow min-h-0 overflow-y-auto custom-scroll px-2 py-2 space-y-1.5">
      <!-- 只有首屏（还没有数据）才占位转圈；后续刷新一律静默，避免点一下整个列表闪一下 -->
      <div v-if="loading && rules.length === 0" class="text-xs text-text-secondary text-center py-6">
        <i class="fas fa-spinner fa-spin"></i>
      </div>

      <div
        v-else-if="rules.length === 0"
        class="text-xs text-text-secondary text-center py-8 px-3 border border-dashed border-border rounded-lg"
      >
        {{ t('portForward.empty', '还没有规则') }}
      </div>

      <div
        v-for="rule in rules"
        :key="rule.id"
        class="pf-card rounded-lg border border-border px-2.5 py-2 transition-colors"
        :class="{ 'pf-card--editing': editing && editingId === rule.id }"
      >
        <div class="flex items-center gap-1.5 min-w-0">
          <span
            class="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded border flex-shrink-0 pf-type"
            :class="typeBadgeClass(rule.type)"
            :title="typeLabel(rule.type)"
          >{{ typeBadge(rule.type) }}</span>
          <!-- 监听端是这条规则的"身份"，优先完整显示；目标地址过长时由目标那一侧截断 -->
          <span class="text-xs font-mono text-foreground truncate flex-shrink-0 max-w-[55%]" :title="`${rule.bind_host}:${rule.bind_port}`">
            {{ rule.bind_host }}:{{ rule.bind_port }}
          </span>
          <template v-if="rule.type !== 'dynamic'">
            <i class="fas fa-arrow-right text-[9px] flex-shrink-0 pf-muted-icon"></i>
            <span class="text-xs font-mono text-text-secondary truncate" :title="`${rule.target_host}:${rule.target_port}`">
              {{ rule.target_host }}:{{ rule.target_port }}
            </span>
          </template>
          <span v-else class="text-[11px] text-text-secondary truncate">SOCKS5</span>
        </div>

        <div class="flex items-center justify-between gap-2 mt-1.5">
          <span class="text-[11px] flex items-center gap-1.5 min-w-0 pf-status" :class="statusTextClass(rule)">
            <!-- 状态点用 span 不用 <i>：全局 `i { color: var(--icon-color) }` 会盖掉颜色 -->
            <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 transition-colors pf-dot" :class="dotClass(rule)"></span>
            <span v-if="statusOf(rule.id).running" class="truncate">
              {{ t('portForward.running', '运行中') }}<template v-if="statusOf(rule.id).connCount"> · {{ t('portForward.connections', { count: statusOf(rule.id).connCount }) }}</template><template v-if="rule.type === 'remote' && rule.bind_port === 0 && statusOf(rule.id).remotePort"> · {{ t('portForward.remoteAssigned', { port: statusOf(rule.id).remotePort }) }}</template>
            </span>
            <span v-else-if="statusOf(rule.id).reconnecting" class="truncate" :title="statusOf(rule.id).error">{{ t('portForward.reconnecting', '连接断开，正在重连…') }}</span>
            <span v-else-if="statusOf(rule.id).error" class="truncate" :title="statusOf(rule.id).error">{{ statusOf(rule.id).error }}</span>
            <span v-else>{{ t('portForward.stopped', '已停止') }}</span>
          </span>

          <div class="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              class="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors disabled:opacity-60 pf-ibtn pf-action"
              :class="isActive(rule) ? 'pf-action--stop' : 'pf-action--start'"
              :disabled="busyIds.has(rule.id)"
              @click="toggleRule(rule)"
              :title="isActive(rule) ? t('portForward.stop', '停止') : t('portForward.start', '启动')"
              :aria-label="isActive(rule) ? t('portForward.stop', '停止') : t('portForward.start', '启动')"
            >
              <i v-if="busyIds.has(rule.id)" class="fas fa-spinner fa-spin"></i>
              <i v-else :class="isActive(rule) ? 'fas fa-stop' : 'fas fa-play'"></i>
            </button>
            <button
              type="button"
              class="w-6 h-6 flex items-center justify-center rounded text-xs text-text-secondary hover:text-primary hover:bg-hover transition-colors pf-ibtn"
              @click="openEditor(rule)"
              :title="t('common.edit', '编辑')"
              :aria-label="t('common.edit', '编辑')"
            >
              <i class="fas fa-pen-to-square"></i>
            </button>
            <button
              type="button"
              class="w-6 h-6 flex items-center justify-center rounded text-xs text-text-secondary transition-colors pf-ibtn pf-del"
              @click="removeRule(rule)"
              :title="t('common.delete', '删除')"
              :aria-label="t('common.delete', '删除')"
            >
              <i class="fas fa-trash-can"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑 -->
    <form v-if="editing && connectionId && !desktopOnly" class="pf-editor flex-shrink-0 border-t border-border p-3 space-y-2" @submit.prevent="save">
      <div class="flex items-center gap-2">
        <select
          v-model="form.type"
          class="pf-input pf-select flex-1 min-w-0 h-8 pl-2 pr-7 text-xs rounded-md"
          :aria-label="t('portForward.title', '端口转发')"
        >
          <option value="local">{{ t('portForward.type.local', '本地转发 (-L)') }}</option>
          <option value="dynamic">{{ t('portForward.type.dynamic', '动态 SOCKS (-D)') }}</option>
          <option value="remote">{{ t('portForward.type.remote', '远程转发 (-R)') }}</option>
        </select>
        <button
          type="button"
          class="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-md text-text-secondary hover:text-foreground hover:bg-hover pf-ibtn"
          @click="cancelEdit"
          :title="t('common.cancel', '取消')"
          :aria-label="t('common.cancel', '取消')"
        >
          <i class="fas fa-xmark"></i>
        </button>
      </div>
      <p class="text-[11px] text-text-secondary leading-snug m-0">{{ typeHint(form.type) }}</p>

      <div class="flex items-center gap-1.5">
        <input
          v-model.trim="form.bind_host"
          class="pf-input flex-1 min-w-0 h-8 px-2 text-xs font-mono rounded-md"
          :placeholder="t('portForward.bindHost', '监听地址')"
          :title="t('portForward.bindHost', '监听地址')"
          spellcheck="false"
          autocomplete="off"
        />
        <span class="text-text-secondary text-xs">:</span>
        <input
          v-model.number="form.bind_port"
          type="number"
          min="1"
          max="65535"
          class="pf-input w-[76px] flex-shrink-0 h-8 px-2 text-xs font-mono rounded-md"
          :placeholder="t('portForward.bindPort', '端口')"
          :title="t('portForward.bindPort', '端口')"
        />
      </div>

      <div v-if="form.type !== 'dynamic'" class="flex items-center gap-1.5">
        <i class="fas fa-arrow-right text-[9px] flex-shrink-0 pf-muted-icon"></i>
        <input
          v-model.trim="form.target_host"
          class="pf-input flex-1 min-w-0 h-8 px-2 text-xs font-mono rounded-md"
          :placeholder="t('portForward.targetHost', '目标地址')"
          :title="t('portForward.targetHost', '目标地址')"
          spellcheck="false"
          autocomplete="off"
        />
        <span class="text-text-secondary text-xs">:</span>
        <input
          v-model.number="form.target_port"
          type="number"
          min="1"
          max="65535"
          class="pf-input w-[76px] flex-shrink-0 h-8 px-2 text-xs font-mono rounded-md"
          :placeholder="t('portForward.targetPort', '端口')"
          :title="t('portForward.targetPort', '端口')"
        />
      </div>

      <p v-if="exposedBind" class="text-[11px] leading-snug m-0 flex items-start gap-1.5 pf-warn">
        <span class="pf-warn-mark flex-shrink-0">!</span>
        <span>{{ t('portForward.exposedWarning', '监听在非回环地址上，同一网络中的其他设备也能访问此端口') }}</span>
      </p>

      <div class="flex items-center justify-between gap-2">
        <label class="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer select-none">
          <input type="checkbox" v-model="form.auto_start" class="accent-primary" />
          {{ t('portForward.autoStart', '随应用启动') }}
        </label>
        <button
          type="submit"
          class="h-7 px-3 rounded-md text-xs font-medium bg-primary text-white hover:bg-primary-dark disabled:opacity-50"
          :disabled="saving"
        >
          <i v-if="saving" class="fas fa-spinner fa-spin mr-1 pf-on-primary"></i>{{ t('common.save', '保存') }}
        </button>
      </div>

      <p v-if="formError" class="text-[11px] m-0 pf-form-error">{{ formError }}</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSessionStore } from '../stores/session.store';
import { useConfirmDialog } from '../composables/useConfirmDialog';
import apiClient from '../utils/apiClient';

type RuleType = 'local' | 'remote' | 'dynamic';

interface Rule {
  id: number;
  connection_id: number;
  type: RuleType;
  bind_host: string;
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
  auto_start: number;
}

interface Status {
  ruleId: number;
  running: boolean;
  reconnecting?: boolean;
  error?: string;
  connCount?: number;
  remotePort?: number;
}

const sessionStore = useSessionStore();
const { activeSession } = storeToRefs(sessionStore);
const { showConfirmDialog } = useConfirmDialog();
const { t } = useI18n();

const connectionId = computed(() => {
  const id = Number(activeSession.value?.connectionId);
  return Number.isInteger(id) && id > 0 ? id : null;
});
const activeConnectionName = computed(() => activeSession.value?.connectionName ?? '');

const rules = ref<Rule[]>([]);
const statuses = ref<Record<number, Status>>({});
const loading = ref(false);
const saving = ref(false);
const formError = ref('');
/** 后端回 403 PORT_FORWARD_DESKTOP_ONLY（非桌面模式） */
const desktopOnly = ref(false);
// 正在启停的规则 id：只让对应那条的按钮转圈，列表本身不动
const busyIds = ref<Set<number>>(new Set());

const editing = ref(false);
const editingId = ref<number | null>(null);
const defaultForm = () => ({
  type: 'local' as RuleType,
  bind_host: '127.0.0.1',
  bind_port: 8080 as number | string,
  target_host: '127.0.0.1',
  target_port: 80 as number | string,
  auto_start: true,
});
const form = ref(defaultForm());

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// -L / -D 在本机监听；-R 的监听在服务器上，是否暴露由服务器的 GatewayPorts 决定，这里只提示本机的情况
const exposedBind = computed(() => {
  if (form.value.type === 'remote') return false;
  const host = (form.value.bind_host || '127.0.0.1').trim().toLowerCase();
  return !LOOPBACK.has(host) && !host.startsWith('127.');
});

const statusOf = (id: number): Status => statuses.value[id] ?? { ruleId: id, running: false };
const isActive = (rule: Rule) => {
  const s = statusOf(rule.id);
  return s.running || !!s.reconnecting;
};

const dotClass = (rule: Rule) => {
  if (busyIds.value.has(rule.id)) return 'pf-dot--busy';
  const s = statusOf(rule.id);
  if (s.running) return 'pf-dot--running';
  if (s.reconnecting) return 'pf-dot--busy';
  if (s.error) return 'pf-dot--error';
  return '';
};

const statusTextClass = (rule: Rule) => {
  const s = statusOf(rule.id);
  if (s.running) return 'pf-status--running';
  if (s.error && !s.reconnecting) return 'pf-status--error';
  return '';
};

const typeBadge = (type: RuleType) => (type === 'local' ? 'L' : type === 'dynamic' ? 'D' : 'R');
const typeBadgeClass = (type: RuleType) => `pf-type--${type}`;
const typeLabel = (type: RuleType) => t(`portForward.type.${type}`);
const typeHint = (type: RuleType) => t(`portForward.typeHint.${type}`);

const isDesktopOnlyError = (err: any) => err?.response?.status === 403 && err?.response?.data?.code === 'PORT_FORWARD_DESKTOP_ONLY';

const load = async (silent = false) => {
  const id = connectionId.value;
  if (!id) {
    rules.value = [];
    statuses.value = {};
    return;
  }
  if (!silent) loading.value = true;
  try {
    const res = await apiClient.get('/port-forwards', { params: { connectionId: id } });
    // 请求期间切换了会话：丢弃旧结果
    if (connectionId.value !== id) return;
    rules.value = res.data.rules ?? [];
    statuses.value = Object.fromEntries((res.data.statuses ?? []).map((s: Status) => [s.ruleId, s]));
    desktopOnly.value = false;
  } catch (err: any) {
    if (isDesktopOnlyError(err)) {
      desktopOnly.value = true;
      stopPolling();
    }
    console.error('[PortForward] 加载失败:', err?.message);
  } finally {
    loading.value = false;
  }
};

const openEditor = (rule?: Rule) => {
  formError.value = '';
  editing.value = true;
  editingId.value = rule?.id ?? null;
  form.value = rule
    ? {
        type: rule.type,
        bind_host: rule.bind_host,
        bind_port: rule.bind_port,
        target_host: rule.target_host ?? '127.0.0.1',
        target_port: rule.target_port ?? 80,
        auto_start: !!rule.auto_start,
      }
    : defaultForm();
};

const cancelEdit = () => {
  editing.value = false;
  editingId.value = null;
  formError.value = '';
};

const isValidPort = (v: unknown, allowZero = false) => {
  const n = Number(v);
  return Number.isInteger(n) && n <= 65535 && (n >= 1 || (allowZero && n === 0));
};

const save = async () => {
  if (!connectionId.value || saving.value) return;
  const isDynamic = form.value.type === 'dynamic';
  const payload = {
    type: form.value.type,
    bind_host: (form.value.bind_host || '').trim() || '127.0.0.1',
    bind_port: Number(form.value.bind_port),
    target_host: isDynamic ? null : (form.value.target_host || '').trim(),
    target_port: isDynamic ? null : Number(form.value.target_port),
    auto_start: form.value.auto_start,
  };
  if (!isValidPort(payload.bind_port) || (!isDynamic && !isValidPort(payload.target_port))) {
    formError.value = t('portForward.invalidPort', '端口必须是 1-65535 之间的整数');
    return;
  }
  if (!isDynamic && !payload.target_host) {
    formError.value = t('portForward.targetRequired', '请填写目标地址');
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    if (editingId.value) {
      await apiClient.put(`/port-forwards/${editingId.value}`, payload);
    } else {
      await apiClient.post('/port-forwards', payload, { params: { connectionId: connectionId.value } });
    }
    cancelEdit();
    await load(true);
  } catch (err: any) {
    formError.value = err?.response?.data?.message || err?.message || t('portForward.saveFailed', '保存失败');
  } finally {
    saving.value = false;
  }
};

const toggleRule = async (rule: Rule) => {
  if (busyIds.value.has(rule.id)) return;
  const active = isActive(rule);
  busyIds.value.add(rule.id);
  try {
    await apiClient.post(`/port-forwards/${rule.id}/${active ? 'stop' : 'start'}`);
  } catch (err: any) {
    // 启动失败的原因会出现在状态里（后端记住了最后一次错误）
    console.error('[PortForward] 启停失败:', err?.response?.data?.message || err?.message);
  } finally {
    // 先刷到新状态再撤掉转圈，否则中间会闪一帧旧图标
    await load(true);
    busyIds.value.delete(rule.id);
  }
};

const removeRule = async (rule: Rule) => {
  const confirmed = await showConfirmDialog({
    message: t('portForward.confirmDelete', { target: `${rule.bind_host}:${rule.bind_port}` }),
  });
  if (!confirmed) return;
  try {
    await apiClient.delete(`/port-forwards/${rule.id}`);
    if (editingId.value === rule.id) cancelEdit();
    await load(true);
  } catch (err: any) {
    console.error('[PortForward] 删除失败:', err?.message);
  }
};

// 断线后后端会自动重连，状态得跟着变：5s 静默刷一次
let pollTimer: ReturnType<typeof setInterval> | null = null;
const stopPolling = () => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
};

watch(
  connectionId,
  id => {
    // 换会话时先清空，别让上一个会话的规则留在屏幕上
    rules.value = [];
    statuses.value = {};
    cancelEdit();
    stopPolling();
    load();
    if (id) pollTimer = setInterval(() => { if (!saving.value && !desktopOnly.value) load(true); }, 5000);
  },
  { immediate: true },
);

onUnmounted(stopPolling);
</script>

<style scoped>
/*
 * 状态色统一走语义变量 + color-mix：深浅主题都靠 :root 变量整体替换，
 * 与 --text-color 混合后浅色主题自动加深、深色主题自动提亮。
 */
.pf-card {
  background-color: color-mix(in srgb, var(--text-color) 3%, transparent);
}
.pf-card:hover,
.pf-card--editing {
  border-color: color-mix(in srgb, var(--color-primary) 45%, var(--border-color));
}
.pf-editor {
  background-color: color-mix(in srgb, var(--text-color) 4%, transparent);
}

.pf-input {
  color: var(--text-color);
  background-color: var(--app-bg-color);
  border: 1px solid var(--border-color);
}
.pf-input:focus {
  outline: none;
  border-color: var(--input-focus-border-color);
  box-shadow: 0 0 0 1px var(--input-focus-border-color);
}
.pf-select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3e%3cpath fill='none' stroke='%236c757d' stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M2 5l6 6 6-6'/%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
  background-size: 12px 10px;
}

.pf-muted-icon {
  color: color-mix(in srgb, var(--text-color-secondary) 70%, transparent);
}

.pf-status {
  color: var(--text-color-secondary);
}
.pf-status--running {
  color: color-mix(in oklab, var(--color-success) 78%, var(--text-color));
}
.pf-status--error {
  color: color-mix(in oklab, var(--color-error) 78%, var(--text-color));
}

.pf-dot {
  background-color: color-mix(in oklab, var(--text-color) 32%, transparent);
}
.pf-dot--running {
  background-color: color-mix(in oklab, var(--color-success) 88%, var(--text-color));
}
.pf-dot--error {
  background-color: color-mix(in oklab, var(--color-error) 88%, var(--text-color));
}
.pf-dot--busy {
  background-color: color-mix(in oklab, var(--color-warning) 80%, var(--text-color));
  animation: pf-pulse 1s ease-in-out infinite;
}

.pf-action--start {
  color: color-mix(in oklab, var(--color-success) 78%, var(--text-color));
}
.pf-action--stop {
  color: color-mix(in oklab, #ea580c 82%, var(--text-color));
}
.pf-action--start:hover {
  background-color: color-mix(in oklab, var(--color-success) 16%, transparent);
}
.pf-action--stop:hover {
  background-color: color-mix(in oklab, #ea580c 16%, transparent);
}
/* 全局 `i, .fas { color: var(--icon-color) }` 会盖掉按钮自己的颜色 */
.pf-ibtn i {
  color: inherit;
}
.pf-on-primary {
  color: inherit;
}

.pf-del:hover {
  color: var(--color-error);
  background-color: color-mix(in oklab, var(--color-error) 14%, transparent);
}

.pf-type {
  color: color-mix(in oklab, var(--pf-accent) 78%, var(--text-color));
  border-color: color-mix(in oklab, var(--pf-accent) 42%, transparent);
  background-color: color-mix(in oklab, var(--pf-accent) 12%, transparent);
}
.pf-type--local {
  --pf-accent: #0284c7;
}
.pf-type--dynamic {
  --pf-accent: #7c3aed;
}
.pf-type--remote {
  --pf-accent: #d97706;
}

.pf-warn {
  color: color-mix(in oklab, #d97706 80%, var(--text-color));
}
.pf-warn-mark {
  width: 14px;
  height: 14px;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background-color: #d97706;
  margin-top: 1px;
}
.pf-form-error {
  color: color-mix(in oklab, var(--color-error) 85%, var(--text-color));
}

@keyframes pf-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
</style>
