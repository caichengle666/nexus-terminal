<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 权限编辑器：把八进制 `755` 这种「只有老手才读得懂」的输入，换成
 * 3×3 的 rwx 勾选网格 + 一个仍然可以直接敲的八进制输入框。
 *
 * 设计取舍：
 * - 勾选网格和八进制输入框**双向同步**，谁改都行。网格只覆盖低 9 位，
 *   改动时用 `& ~0o777 | bits` 保住 setuid/setgid/sticky 那一位，不会悄悄丢权限。
 * - 所有者/所属组留空表示「不修改」—— 只改权限的人不该被 chown 的权限错误打断，
 *   所以这里不做预填，只用 placeholder 提示当前值。
 * - 前端只做提示性校验（字符集与后端 sftp/chown-command.ts 一致），真正的校验在后端。
 */
const props = defineProps<{
  /** 八进制权限字符串，3~4 位，例如 `755` / `0755` / `4755`。 */
  mode: string;
  /** 所有者（用户名或 UID），空字符串 = 不修改。 */
  owner: string;
  /** 所属组（组名或 GID），空字符串 = 不修改。 */
  group: string;
  /** 当前所有者的 uid，仅用于 placeholder 提示。 */
  currentUid?: number | null;
  currentGid?: number | null;
}>();

const emit = defineEmits<{
  (e: 'update:mode', value: string): void;
  (e: 'update:owner', value: string): void;
  (e: 'update:group', value: string): void;
}>();

const { t } = useI18n();

const MASKS = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];

const numericMode = computed(() => {
  const parsed = parseInt((props.mode || '000').trim(), 8);
  return Number.isFinite(parsed) ? parsed : 0;
});

const bits = computed(() => MASKS.map((mask) => (numericMode.value & mask) !== 0));

const toggleBit = (index: number) => {
  const mask = MASKS[index];
  const next = (numericMode.value & mask) !== 0
    ? numericMode.value & ~mask
    : numericMode.value | mask;
  // `& 0o7777` 保住特殊位；不足 3 位补零，避免出现 "5" 这种非法值
  emit('update:mode', (next & 0o7777).toString(8).padStart(3, '0'));
};

const onModeInput = (event: Event) => {
  emit('update:mode', (event.target as HTMLInputElement).value);
};

/** 每列的小标题：所有者 / 所属组 / 其他 */
const columnLabels = computed(() => [
  t('fileManager.permissions.ownerColumn', '所有者'),
  t('fileManager.permissions.groupColumn', '所属组'),
  t('fileManager.permissions.otherColumn', '其他'),
]);

const rowLabels = computed(() => [
  { label: t('fileManager.permissions.read', '读取'), short: 'r' },
  { label: t('fileManager.permissions.write', '写入'), short: 'w' },
  { label: t('fileManager.permissions.execute', '执行'), short: 'x' },
]);

/** 当前每列的八进制数字，勾选时实时变化，方便对照 `755` */
const columnDigits = computed(() =>
  [6, 3, 0].map((shift) => ((numericMode.value >> shift) & 0o7).toString())
);

/** 与后端 isValidChownName 一致：用户名/组名或数字 ID */
const NAME_RE = /^([0-9]{1,10}|[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/;
const ownerInvalid = computed(() => !!props.owner.trim() && !NAME_RE.test(props.owner.trim()));
const groupInvalid = computed(() => !!props.group.trim() && !NAME_RE.test(props.group.trim()));
const modeInvalid = computed(() => !!props.mode.trim() && !/^[0-7]{3,4}$/.test(props.mode.trim()));

const ownerPlaceholder = computed(() =>
  props.currentUid != null
    ? t('fileManager.permissions.ownerPlaceholderWithValue', { uid: props.currentUid })
    : t('fileManager.permissions.ownerPlaceholder', '留空不修改')
);

const groupPlaceholder = computed(() =>
  props.currentGid != null
    ? t('fileManager.permissions.groupPlaceholderWithValue', { gid: props.currentGid })
    : t('fileManager.permissions.groupPlaceholder', '留空不修改')
);
</script>

<template>
  <div class="space-y-3.5">
    <!-- 3×3 rwx 勾选网格 -->
    <div>
      <div class="grid grid-cols-[2.6rem_repeat(3,1fr)] gap-x-1.5 items-center text-[11px] text-text-secondary mb-1">
        <span></span>
        <span v-for="(label, col) in columnLabels" :key="label" class="text-center font-medium truncate">
          {{ label }}
          <span class="font-mono text-text-secondary/60">({{ columnDigits[col] }})</span>
        </span>
      </div>
      <div class="space-y-1">
        <div
          v-for="(row, rowIndex) in rowLabels"
          :key="row.short"
          class="grid grid-cols-[2.6rem_repeat(3,1fr)] gap-x-1.5 items-center"
        >
          <span class="text-[11px] text-text-secondary">
            {{ row.label }}<span class="font-mono text-text-secondary/50 ml-0.5">{{ row.short }}</span>
          </span>
          <label
            v-for="col in 3"
            :key="col"
            class="flex items-center justify-center h-7 rounded-md border cursor-pointer transition-colors"
            :class="bits[(col - 1) * 3 + rowIndex]
              ? 'bg-primary/15 border-primary/40'
              : 'bg-background border-border/60 hover:bg-header/40'"
          >
            <input
              type="checkbox"
              class="sr-only"
              :checked="bits[(col - 1) * 3 + rowIndex]"
              @change="toggleBit((col - 1) * 3 + rowIndex)"
            />
            <i
              :class="[
                'text-[10px]',
                bits[(col - 1) * 3 + rowIndex] ? 'fas fa-check text-primary' : 'fas fa-minus text-text-secondary/40'
              ]"
            ></i>
          </label>
        </div>
      </div>
    </div>

    <!-- 八进制输入（仍然可以直接敲） -->
    <div>
      <label class="block text-xs font-medium text-text-secondary mb-1">
        {{ t('fileManager.modals.labels.newPermissions', '权限数值 (8进制)：') }}
      </label>
      <input
        type="text"
        :value="mode"
        inputmode="numeric"
        maxlength="4"
        @input="onModeInput"
        placeholder="0755"
        data-testid="chmod-octal"
        class="w-full px-3 py-2 bg-input border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm text-foreground font-mono tracking-widest"
      />
      <p v-if="modeInvalid" class="mt-1 text-xs text-error">
        {{ t('fileManager.errors.invalidPermissionsFormat') }}
      </p>
    </div>

    <!-- 所有者 / 所属组 -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label class="block text-xs font-medium text-text-secondary mb-1">
          {{ t('fileManager.permissions.owner', '所有者') }}
        </label>
        <input
          type="text"
          :value="owner"
          @input="emit('update:owner', ($event.target as HTMLInputElement).value)"
          :placeholder="ownerPlaceholder"
          autocomplete="off"
          spellcheck="false"
          data-testid="chown-owner"
          class="w-full px-3 py-2 bg-input border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm text-foreground font-mono"
        />
        <p v-if="ownerInvalid" class="mt-1 text-xs text-error">{{ t('fileManager.permissions.invalidName') }}</p>
      </div>
      <div>
        <label class="block text-xs font-medium text-text-secondary mb-1">
          {{ t('fileManager.permissions.group', '所属组') }}
        </label>
        <input
          type="text"
          :value="group"
          @input="emit('update:group', ($event.target as HTMLInputElement).value)"
          :placeholder="groupPlaceholder"
          autocomplete="off"
          spellcheck="false"
          data-testid="chown-group"
          class="w-full px-3 py-2 bg-input border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-sm text-foreground font-mono"
        />
        <p v-if="groupInvalid" class="mt-1 text-xs text-error">{{ t('fileManager.permissions.invalidName') }}</p>
      </div>
    </div>
    <p class="text-[11px] leading-snug text-text-secondary">
      {{ t('fileManager.permissions.chownHint', '所有者/所属组可填用户名或数字 UID；修改为他人所有通常需要 root 权限。') }}
    </p>
  </div>
</template>
