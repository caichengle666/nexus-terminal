<script setup lang="ts">
import { ref, defineEmits } from 'vue'; 

const emit = defineEmits<{
  (e: 'send-key', keySequence: string): void;
}>();

// +++ Add state for modifier keys +++
const isCtrlActive = ref(false);
const isAltActive = ref(false);

// +++ Function to toggle modifier state +++
const toggleModifier = (modifier: 'ctrl' | 'alt') => {
  if (modifier === 'ctrl') {
    isCtrlActive.value = !isCtrlActive.value;
    isAltActive.value = false; // Ctrl and Alt are mutually exclusive
  } else if (modifier === 'alt') {
    isAltActive.value = !isAltActive.value;
    isCtrlActive.value = false; // Ctrl and Alt are mutually exclusive
  }
};

// +++ Modified sendKey function +++
const sendKey = (keyDef: KeyDefinition) => {
  // Handle modifier key clicks
  if (keyDef.type === 'modifier') {
    toggleModifier(keyDef.label.toLowerCase() as 'ctrl' | 'alt');
    return; // Just toggle state, don't emit anything
  }

  // Determine the sequence to send
  let sequence = keyDef.sequence ?? keyDef.label; // Default to label if no sequence (e.g., for 'A')

  if (isCtrlActive.value) {
    // Handle Ctrl combinations (example: convert A-Z to control characters 1-26)
    if (keyDef.type === 'char' && keyDef.label.length === 1 && keyDef.label >= 'A' && keyDef.label <= 'Z') {
      sequence = String.fromCharCode(keyDef.label.charCodeAt(0) - 'A'.charCodeAt(0) + 1);
    } else if (keyDef.label === 'Ctrl+C') { // Keep predefined Ctrl+C
       sequence = '\x03';
    }
    // Add more Ctrl combinations here if needed
    console.log(`[VirtualKeyboard] Sending Ctrl + ${keyDef.label} as ${JSON.stringify(sequence)}`);
  } else if (isAltActive.value) {
    // Handle Alt combinations (typically prefix with ESC)
    sequence = '\x1b' + sequence;
    console.log(`[VirtualKeyboard] Sending Alt + ${keyDef.label} as ${JSON.stringify(sequence)}`);
  } else {
     // Send the standard sequence
     console.log(`[VirtualKeyboard] Sending key: ${JSON.stringify(sequence)}`);
  }

  // Emit the final sequence
  emit('send-key', sequence);

  // Reset modifier state after sending a combined key
  if (isCtrlActive.value || isAltActive.value) {
    isCtrlActive.value = false;
    isAltActive.value = false;
  }
};

// +++ Define key structure +++
interface KeyDefinition {
  label: string;
  sequence?: string; // Sequence if different from label
  type: 'modifier' | 'control' | 'char' | 'navigation' | 'special'; // Key type
}

// +++ Updated key layout definition +++
const keys: KeyDefinition[] = [
  // Row 1: Modifiers and special controls
  { label: 'Ctrl', type: 'modifier' },
  { label: 'Alt', type: 'modifier' },
  { label: 'Tab', sequence: '\t', type: 'control' },
  { label: 'Esc', sequence: '\x1b', type: 'control' },
  // Row 2: Navigation and common symbols
  { label: '↑', sequence: '\x1b[A', type: 'navigation' },
  { label: '↓', sequence: '\x1b[B', type: 'navigation' },
  { label: '←', sequence: '\x1b[D', type: 'navigation' },
  { label: '→', sequence: '\x1b[C', type: 'navigation' },
  { label: 'Home', sequence: '\x1b[1~', type: 'navigation' }, // +++ Home +++
  { label: 'End', sequence: '\x1b[4~', type: 'navigation' }, // +++ End +++
  { label: 'PgUp', sequence: '\x1b[5~', type: 'navigation' }, // +++ PageUp +++
  { label: 'PgDn', sequence: '\x1b[6~', type: 'navigation' }, // +++ PageDown +++
  // Row 3: Function Keys (F1-F12)
  { label: 'F1', sequence: '\x1b[11~', type: 'special' }, { label: 'F2', sequence: '\x1b[12~', type: 'special' },
  { label: 'F3', sequence: '\x1b[13~', type: 'special' }, { label: 'F4', sequence: '\x1b[14~', type: 'special' },
  { label: 'F5', sequence: '\x1b[15~', type: 'special' }, { label: 'F6', sequence: '\x1b[17~', type: 'special' },
  { label: 'F7', sequence: '\x1b[18~', type: 'special' }, { label: 'F8', sequence: '\x1b[19~', type: 'special' },
  { label: 'F9', sequence: '\x1b[20~', type: 'special' }, { label: 'F10', sequence: '\x1b[21~', type: 'special' },
  { label: 'F11', sequence: '\x1b[23~', type: 'special' }, { label: 'F12', sequence: '\x1b[24~', type: 'special' },
  // Row 4: Alphabet Keys (A-Z)
  { label: 'A', type: 'char' }, { label: 'B', type: 'char' }, { label: 'C', type: 'char' },
  { label: 'D', type: 'char' }, { label: 'E', type: 'char' }, { label: 'F', type: 'char' },
  { label: 'G', type: 'char' }, { label: 'H', type: 'char' }, { label: 'I', type: 'char' },
  { label: 'J', type: 'char' }, { label: 'K', type: 'char' }, { label: 'L', type: 'char' },
  { label: 'M', type: 'char' }, { label: 'N', type: 'char' }, { label: 'O', type: 'char' },
  { label: 'P', type: 'char' }, { label: 'Q', type: 'char' }, { label: 'R', type: 'char' },
  { label: 'S', type: 'char' }, { label: 'T', type: 'char' }, { label: 'U', type: 'char' },
  { label: 'V', type: 'char' }, { label: 'W', type: 'char' }, { label: 'X', type: 'char' },
  { label: 'Y', type: 'char' }, { label: 'Z', type: 'char' },
  // Add numbers or other symbols if needed
];
</script>

<template>
  <!-- +++ Updated template loop and bindings +++ -->
  <div class="virtual-keyboard-bar flex flex-wrap items-center justify-center gap-1 p-1 bg-background border-t border-border">
    <button
      v-for="keyDef in keys"
      :key="keyDef.label"
      @click="sendKey(keyDef)"
      class="px-3 py-1.5 rounded border border-border bg-input text-foreground text-xs hover:bg-border focus:outline-none focus:ring-1 focus:ring-primary transition-colors duration-150"
      :class="{
        'bg-primary text-primary-foreground hover:bg-primary/90': // Style for active modifiers
          (keyDef.label === 'Ctrl' && isCtrlActive) ||
          (keyDef.label === 'Alt' && isAltActive)
      }"
      :title="keyDef.label"
    >
      {{ keyDef.label }}
    </button>
  </div>
</template>

<style scoped>
.virtual-keyboard-bar {
  /* Base styles */
  flex-wrap: wrap; /* Allow wrapping */
}

button {
  min-width: 40px; /* Ensure tappable area */
  text-align: center;
}

/* Optional: Add specific styles for modifier keys */
/*
button[title="Ctrl"], button[title="Alt"] {
  font-weight: bold;
}
*/
</style>
