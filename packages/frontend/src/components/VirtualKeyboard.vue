<script setup lang="ts">
import { ref } from 'vue';

const emit = defineEmits<{
  (e: 'send-key', keySequence: string): void;
}>();

// +++ Add state for modifier keys +++
const isCtrlActive = ref(false);
const isAltActive = ref(false);
const isShiftActive = ref(false);
const isCapsLockActive = ref(false);

// +++ Function to toggle modifier state +++
const toggleModifier = (modifier: 'ctrl' | 'alt' | 'shift' | 'caps') => {
  if (modifier === 'ctrl') {
    isCtrlActive.value = !isCtrlActive.value;
  } else if (modifier === 'alt') {
    isAltActive.value = !isAltActive.value;
  } else if (modifier === 'shift') {
    isShiftActive.value = !isShiftActive.value;
  } else if (modifier === 'caps') {
    isCapsLockActive.value = !isCapsLockActive.value;
  }
};

// +++ Modified sendKey function +++
const sendKey = (keyDef: KeyDefinition) => {
  // Handle modifier key clicks
  if (keyDef.type === 'modifier' && keyDef.modifier) {
    toggleModifier(keyDef.modifier);
    return; // Just toggle state, don't emit anything
  }

  const shouldShift = isShiftActive.value !== isCapsLockActive.value;
  let sequence = shouldShift && keyDef.shiftSequence !== undefined
    ? keyDef.shiftSequence
    : keyDef.sequence ?? keyDef.label;

  if (isCtrlActive.value) {
    const ctrlCharacter = keyDef.ctrlCharacter ?? keyDef.sequence;
    if (ctrlCharacter && /^[a-z]$/i.test(ctrlCharacter)) {
      sequence = String.fromCharCode(ctrlCharacter.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0) + 1);
    }
  }
  if (isAltActive.value) {
    sequence = '\x1b' + sequence;
  }

  emit('send-key', sequence);

  isCtrlActive.value = false;
  isAltActive.value = false;
  isShiftActive.value = false;
};

// +++ Define key structure +++
interface KeyDefinition {
  id: string;
  label: string;
  sequence?: string; // Sequence if different from label
  shiftSequence?: string;
  ctrlCharacter?: string;
  type: 'modifier' | 'control' | 'char' | 'navigation' | 'special'; // Key type
  modifier?: 'ctrl' | 'alt' | 'shift' | 'caps';
  width?: 'wide' | 'extra-wide';
}

const key = (id: string, label: string, sequence: string, type: KeyDefinition['type'], options: Partial<KeyDefinition> = {}): KeyDefinition => ({
  id,
  label,
  sequence,
  type,
  ...options,
});

const letters = (value: string): KeyDefinition[] => [...value].map(letter => key(letter, letter, letter.toLowerCase(), 'char', {
  shiftSequence: letter,
  ctrlCharacter: letter,
}));

const functionKeys = Array.from({ length: 12 }, (_, index) => {
  const number = index + 1;
  const sequence = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24][index];
  return key(`f${number}`, `F${number}`, `\x1b[${sequence}~`, 'special');
});

const keyboardRows: KeyDefinition[][] = [
  [key('esc', 'Esc', '\x1b', 'control'), ...functionKeys],
  [
    key('backtick', '`', '`', 'char', { shiftSequence: '~' }),
    ...[
      ['1', '!'], ['2', '@'], ['3', '#'], ['4', '$'], ['5', '%'], ['6', '^'],
      ['7', '&'], ['8', '*'], ['9', '('], ['0', ')'], ['minus', '-', '_'], ['equals', '=', '+'],
    ].map(([id, label]) => key(id, label, id.length === 1 ? id : label, 'char', { shiftSequence: label })),
    key('backspace', 'Backspace', '\x7f', 'control', { width: 'wide' }),
  ],
  [key('tab', 'Tab', '\t', 'control', { width: 'wide' }), ...letters('QWERTYUIOP'), key('left-bracket', '[', '[', 'char', { shiftSequence: '{' }), key('right-bracket', ']', ']', 'char', { shiftSequence: '}' }), key('backslash', '\\', '\\', 'char', { shiftSequence: '|' })],
  [key('caps', 'Caps', '', 'modifier', { modifier: 'caps', width: 'wide' }), ...letters('ASDFGHJKL'), key('semicolon', ';', ';', 'char', { shiftSequence: ':' }), key('quote', "'", "'", 'char', { shiftSequence: '"' }), key('enter', 'Enter', '\r', 'control', { width: 'wide' })],
  [key('left-shift', 'Shift', '', 'modifier', { modifier: 'shift', width: 'extra-wide' }), ...letters('ZXCVBNM'), key('comma', ',', ',', 'char', { shiftSequence: '<' }), key('period', '.', '.', 'char', { shiftSequence: '>' }), key('slash', '/', '/', 'char', { shiftSequence: '?' }), key('right-shift', 'Shift', '', 'modifier', { modifier: 'shift', width: 'extra-wide' })],
  [
    key('left-ctrl', 'Ctrl', '', 'modifier', { modifier: 'ctrl', width: 'wide' }),
    key('left-alt', 'Alt', '', 'modifier', { modifier: 'alt', width: 'wide' }),
    key('space', 'Space', ' ', 'char', { width: 'extra-wide' }),
    key('right-alt', 'Alt', '', 'modifier', { modifier: 'alt', width: 'wide' }),
    key('right-ctrl', 'Ctrl', '', 'modifier', { modifier: 'ctrl', width: 'wide' }),
  ],
  [
    key('home', 'Home', '\x1b[1~', 'navigation'), key('end', 'End', '\x1b[4~', 'navigation'),
    key('page-up', 'PgUp', '\x1b[5~', 'navigation'), key('page-down', 'PgDn', '\x1b[6~', 'navigation'),
    key('insert', 'Ins', '\x1b[2~', 'navigation'), key('delete', 'Del', '\x1b[3~', 'navigation'),
    key('left', '←', '\x1b[D', 'navigation'), key('up', '↑', '\x1b[A', 'navigation'),
    key('down', '↓', '\x1b[B', 'navigation'), key('right', '→', '\x1b[C', 'navigation'),
  ],
];
</script>

<template>
  <div class="virtual-keyboard-bar bg-background border-t border-border">
    <div v-for="row in keyboardRows" :key="row[0].id" class="keyboard-row">
      <button
        v-for="keyDef in row"
        :key="keyDef.id"
        type="button"
        @click="sendKey(keyDef)"
        class="keyboard-key border border-border bg-input text-foreground hover:bg-border focus:outline-none focus:ring-1 focus:ring-primary transition-colors duration-150"
        :class="{
          'key-wide': keyDef.width === 'wide',
          'key-extra-wide': keyDef.width === 'extra-wide',
          'bg-primary text-primary-foreground hover:bg-primary/90':
            (keyDef.modifier === 'ctrl' && isCtrlActive) ||
            (keyDef.modifier === 'alt' && isAltActive) ||
            (keyDef.modifier === 'shift' && isShiftActive) ||
            (keyDef.modifier === 'caps' && isCapsLockActive)
        }"
        :title="keyDef.label"
      >
        {{ keyDef.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.virtual-keyboard-bar {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.375rem;
  max-height: min(34dvh, 18rem);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
}

.keyboard-row {
  display: flex;
  gap: 0.25rem;
  min-width: 0;
}

.keyboard-key {
  min-width: 0;
  min-height: 2.25rem;
  flex: 1 1 0;
  border-radius: 0.35rem;
  padding: 0.3rem 0.15rem;
  font-size: clamp(0.58rem, 2.2vw, 0.75rem);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.keyboard-key.key-wide { flex-grow: 1.5; }
.keyboard-key.key-extra-wide { flex-grow: 2.25; }
</style>
