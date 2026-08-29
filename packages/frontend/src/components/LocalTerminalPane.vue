<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const terminalHost = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let terminalId: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let stopOutputListener: (() => void) | null = null;
let stopExitListener: (() => void) | null = null;

const electronApi = () => (window as any).electronAPI;

const fitTerminal = () => {
  if (!terminal || !fitAddon || !terminalId || !terminalHost.value) return;
  if (terminalHost.value.clientWidth === 0 || terminalHost.value.clientHeight === 0) return;
  fitAddon.fit();
  void electronApi().resizeLocalTerminal({ terminalId, cols: terminal.cols, rows: terminal.rows });
};

onMounted(async () => {
  if (!electronApi()?.createLocalTerminal) {
    error.value = '本地终端仅在 Nexus 桌面端可用。';
    return;
  }

  terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 5000 });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalHost.value!);
  fitAddon.fit();

  try {
    const result = await electronApi().createLocalTerminal({ cols: terminal.cols, rows: terminal.rows });
    terminalId = result.terminalId;
    stopOutputListener = electronApi().onLocalTerminalOutput((payload: { terminalId: string; data: string }) => {
      if (payload.terminalId === terminalId) terminal?.write(payload.data);
    });
    stopExitListener = electronApi().onLocalTerminalExit((payload: { terminalId: string; exitCode: number }) => {
      if (payload.terminalId === terminalId) terminal?.writeln(`\r\n[Nexus] Local shell exited with code ${payload.exitCode}.`);
    });
    terminal.onData((data) => {
      if (terminalId) void electronApi().writeLocalTerminal({ terminalId, data });
    });
    resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(terminalHost.value!);
    fitTerminal();
    terminal.focus();
  } catch (reason: any) {
    error.value = reason?.message || String(reason);
    terminal.dispose();
    terminal = null;
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  stopOutputListener?.();
  stopExitListener?.();
  if (terminalId) void electronApi()?.closeLocalTerminal?.(terminalId);
  terminal?.dispose();
});
</script>

<template>
  <section class="relative h-full min-h-0 bg-black">
    <div ref="terminalHost" class="h-full w-full p-2"></div>
    <div v-if="error" class="absolute inset-0 flex items-center justify-center bg-black/85 p-4 text-center text-sm text-red-300">
      {{ error }}
    </div>
  </section>
</template>
