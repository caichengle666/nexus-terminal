<script setup lang="ts">
defineProps<{
  theme: Record<string, string>;
}>();
</script>

<template>
  <div class="ui-preview" :style="theme" aria-label="界面主题预览">
    <header class="ui-preview__header">
      <div class="ui-preview__brand">Nexus Terminal</div>
      <div class="ui-preview__header-actions">
        <span></span><span></span><span></span>
      </div>
    </header>
    <div class="ui-preview__body">
      <aside class="ui-preview__sidebar">
        <div class="ui-preview__nav-item ui-preview__nav-item--active">终端</div>
        <div class="ui-preview__nav-item">连接</div>
        <div class="ui-preview__nav-item">设置</div>
      </aside>
      <main class="ui-preview__content">
        <div class="ui-preview__title-row">
          <div>
            <strong>工作区</strong>
            <small>服务器连接管理</small>
          </div>
          <button type="button">新建连接</button>
        </div>
        <div class="ui-preview__panel">
          <label>主机地址</label>
          <div class="ui-preview__input">192.168.1.100</div>
          <div class="ui-preview__status-row">
            <span class="ui-preview__status ui-preview__status--success">已连接</span>
            <span class="ui-preview__status ui-preview__status--warning">等待</span>
            <span class="ui-preview__status ui-preview__status--error">错误</span>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.ui-preview {
  overflow: hidden;
  min-height: 210px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--app-bg-color);
  color: var(--text-color);
  font-family: var(--font-family-sans-serif, sans-serif);
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
}

.ui-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 42px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--header-bg-color);
}

.ui-preview__brand {
  font-size: 13px;
  font-weight: 700;
}

.ui-preview__header-actions {
  display: flex;
  gap: 6px;
}

.ui-preview__header-actions span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--icon-color);
  opacity: 0.7;
}

.ui-preview__body {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  min-height: 168px;
}

.ui-preview__sidebar {
  padding: 10px 8px;
  border-right: 1px solid var(--border-color);
  background: var(--header-bg-color);
}

.ui-preview__nav-item {
  margin-bottom: 5px;
  padding: 7px 9px;
  border-radius: 4px;
  color: var(--text-color-secondary);
  font-size: 11px;
}

.ui-preview__nav-item--active {
  background: var(--nav-item-active-bg-color, var(--link-active-bg-color));
  color: var(--link-active-color);
  font-weight: 700;
}

.ui-preview__content {
  min-width: 0;
  padding: 14px;
}

.ui-preview__title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.ui-preview__title-row strong,
.ui-preview__title-row small {
  display: block;
}

.ui-preview__title-row strong {
  font-size: 13px;
}

.ui-preview__title-row small {
  margin-top: 2px;
  color: var(--text-color-secondary);
  font-size: 10px;
}

.ui-preview button {
  flex: 0 0 auto;
  padding: 6px 10px;
  border: 1px solid var(--button-bg-color);
  border-radius: 4px;
  background: var(--button-bg-color);
  color: var(--button-text-color);
  font-size: 10px;
}

.ui-preview__panel {
  padding: 11px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--app-bg-color);
}

.ui-preview__panel label {
  display: block;
  margin-bottom: 5px;
  color: var(--text-color-secondary);
  font-size: 10px;
}

.ui-preview__input {
  padding: 7px 9px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-color);
  font-size: 11px;
}

.ui-preview__status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.ui-preview__status {
  padding: 3px 7px;
  border-radius: 3px;
  color: #fff;
  font-size: 9px;
}

.ui-preview__status--success { background: var(--color-success); color: var(--color-success-text); }
.ui-preview__status--warning { background: var(--color-warning); color: var(--color-warning-text); }
.ui-preview__status--error { background: var(--color-error); color: var(--color-error-text); }

@media (max-width: 520px) {
  .ui-preview__body { grid-template-columns: 72px minmax(0, 1fr); }
  .ui-preview__content { padding: 10px; }
  .ui-preview__title-row { align-items: flex-start; }
}
</style>
