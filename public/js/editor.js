/**
 * Code editor pane.
 *
 * Wraps CodeMirror 6 with Lua syntax highlighting and a Roblox-flavoured
 * completion source (Instance methods, services, globals). Also exports the
 * console's read-eval-print editor.
 */

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { StreamLanguage } from '@codemirror/language';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';

const SERVICESS = [
  'Workspace', 'Lighting', 'Players', 'ReplicatedStorage', 'ServerScriptService',
  'ServerStorage', 'StarterGui', 'StarterPlayer', 'Teams', 'SoundService',
  'RunService', 'TweenService', 'Debris', 'CollectionService', 'HttpService',
  'UserInputService',
];

const INSTANCE_METHODS = [
  'FindFirstChild', 'FindFirstChildOfClass', 'FindFirstChildWhichIsA',
  'FindFirstAncestor', 'FindFirstAncestorOfClass', 'GetChildren', 'GetDescendants',
  'Clone', 'Destroy', 'IsA', 'GetAttribute', 'SetAttribute', 'GetAttributes',
  'AddTag', 'RemoveTag', 'HasTag', 'GetTags', 'WaitForChild',
  'GetPropertyChangedSignal', 'GetFullName', 'IsDescendantOf', 'GetPivot', 'PivotTo',
  // remotes / events
  'FireServer', 'FireClient', 'FireAllClients', 'InvokeServer', 'Connect', 'Once',
  // players
  'GetPlayers', 'GetPlayerByUserId', 'GetPlayerFromCharacter', 'GetUserIdFromNameAsync',
  // tweens / gui
  'Create', 'TweenPosition', 'TweenSize', 'Play', 'Stop', 'Pause', 'Resume',
];

/** Members shown after `:`, grouped so the list stays readable. */
const MEMBER_METHODS = [
  'Connect', 'Once', 'Wait', 'Disconnect',
  'GetChildren', 'GetDescendants', 'FindFirstChild', 'FindFirstChildOfClass',
  'WaitForChild', 'FindFirstAncestor', 'IsA', 'IsDescendantOf',
  'Clone', 'Destroy', 'GetFullName', 'GetAttribute', 'SetAttribute',
  'GetPropertyChangedSignal', 'AddTag', 'RemoveTag', 'HasTag',
  'FireServer', 'FireClient', 'FireAllClients', 'InvokeServer',
  'GetPlayers', 'GetPlayerFromCharacter', 'GetPlayerByUserId',
  'TweenPosition', 'TweenSize', 'GetService', 'FindService',
];

const GLOBALS = [
  'game', 'workspace', 'script', 'shared', 'Instance', 'Vector3', 'CFrame',
  'Color3', 'UDim', 'UDim2', 'Enum', 'task', 'typeof', 'print', 'warn', 'require',
  'loadstring', 'tick', 'time', 'wait', 'spawn', 'delay', 'Random', 'Ray',
  'NumberRange', 'getgenv', 'gethui', 'players',
];

const SNIPPETS = [
  { label: 'Instance.new("Part")', detail: 'new part' },
  { label: 'task.wait(1)', detail: 'wait one second' },
  { label: 'task.spawn(function()', detail: 'background task' },
  { label: 'game:GetService("RunService").Heartbeat:Connect(function(dt)', detail: 'per-frame loop' },
  { label: 'local remote = Instance.new("RemoteEvent")', detail: 'remote event' },
];

const robloxCompletions = (context) => {
  const word = context.matchBefore(/[\w:.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const options = [];
  for (const name of GLOBALS) options.push({ label: name, type: 'variable' });
  for (const name of SERVICESS) options.push({ label: name, type: 'class' });
  for (const name of INSTANCE_METHODS) options.push({ label: name, type: 'method' });
  for (const s of SNIPPETS) options.push({ label: s.label, type: 'text', detail: s.detail });

  // After a `:` the useful list is methods, not globals.
  if (/:\s*\w*$/.test(context.state.sliceDoc(Math.max(0, word.from - 1), word.from))) {
    return {
      from: word.from,
      options: MEMBER_METHODS.map((label) => ({ label, type: 'method' })),
    };
  }
  return { from: word.from, options };
};

export class CodeEditor {
  constructor(host) {
    this.host = host;
    this.readonlyCompartment = new Compartment();
    this.changeHandlers = new Set();
    this.currentPath = null;
    this.savedSource = '';

    const theme = EditorView.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: '#0e141b' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace', lineHeight: '1.65' },
      '.cm-gutters': { backgroundColor: '#0b1016', color: '#3d4c5c', border: 'none' },
      '.cm-activeLine': { backgroundColor: 'rgba(94, 231, 255, 0.045)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(94, 231, 255, 0.08)', color: '#7fb7c9' },
      '.cm-content': { caretColor: '#5ee7ff' },
      '.cm-cursor': { borderLeftColor: '#5ee7ff' },
      '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(94, 231, 255, 0.22) !important' },
    });

    this.view = new EditorView({
      state: EditorState.create({
        doc: '-- Select a script in the explorer, or press "New Script".\n-- Try one of the samples from the Samples tab.\n',
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          foldGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          StreamLanguage.define(lua),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          oneDark,
          theme,
          autocompletion({ override: [robloxCompletions] }),
          keymap.of([
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
            { key: 'Mod-s', run: () => { this.triggerSave(); return true; } },
            { key: 'Mod-Enter', run: () => { this.triggerRun(); return true; } },
          ]),
          this.readonlyCompartment.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            for (const fn of this.changeHandlers) fn(text, this.currentPath);
          }),
        ],
      }),
      parent: host,
    });
  }

  onChange(fn) {
    this.changeHandlers.add(fn);
  }

  setSaveHandler(fn) {
    this.onSave = fn;
  }

  setRunHandler(fn) {
    this.onRun = fn;
  }

  triggerSave() {
    this.savedSource = this.getText();
    this.onSave?.(this.currentPath, this.getText());
  }

  triggerRun() {
    this.triggerSave();
    this.onRun?.(this.currentPath, this.getText());
  }

  getText() {
    return this.view.state.doc.toString();
  }

  setText(text, path = null) {
    this.currentPath = path;
    this.savedSource = text;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  isDirty() {
    return this.getText() !== this.savedSource;
  }

  setReadOnly(flag) {
    this.view.dispatch({
      effects: this.readonlyCompartment.reconfigure(EditorState.readOnly.of(flag)),
    });
  }

  focus() {
    this.view.focus();
  }
}

/** Small console prompt editor (one-liner with history). */
export class ConsolePrompt {
  constructor(host, onRun) {
    this.host = host;
    this.onRun = onRun;
    this.history = [];
    this.historyIndex = -1;
    this.el = document.createElement('textarea');
    this.el.className = 'console-prompt';
    this.el.rows = 3;
    this.el.placeholder = 'print("hello from the server")     — Ctrl+Enter to run';
    this.el.spellcheck = false;
    this.host.appendChild(this.el);
    this.el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'ArrowUp' && this.el.value.split('\n').length === 1) {
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.el.value = this.history[this.history.length - 1 - this.historyIndex] ?? '';
          e.preventDefault();
        }
      } else if (e.key === 'ArrowDown' && this.historyIndex >= 0) {
        this.historyIndex--;
        this.el.value = this.historyIndex < 0 ? '' : this.history[this.history.length - 1 - this.historyIndex];
        e.preventDefault();
      }
    });
  }

  submit() {
    const code = this.el.value.trim();
    if (!code) return;
    this.history.push(code);
    this.historyIndex = -1;
    this.el.value = '';
    this.onRun?.(code);
  }

  setText(code) {
    this.el.value = code;
    this.el.focus();
  }
}
