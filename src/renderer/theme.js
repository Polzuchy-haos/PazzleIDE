// Темы Blockly в палитре Scratch (светлая и тёмная).
import * as Blockly from 'blockly';

const style = (primary, secondary, tertiary) => ({colourPrimary: primary, colourSecondary: secondary, colourTertiary: tertiary});

const blockStyles = {
  logic_blocks: style('#4C97FF', '#4280D7', '#3373CC'),
  loop_blocks: style('#FFAB19', '#EC9C13', '#CF8B17'),
  math_blocks: style('#59C059', '#46B946', '#389438'),
  text_blocks: style('#9966FF', '#855CD6', '#774DCB'),
  list_blocks: style('#FF661A', '#FF5500', '#E64D00'),
  variable_blocks: style('#FF8C1A', '#FF8000', '#DB6E00'),
  variable_dynamic_blocks: style('#FF8C1A', '#FF8000', '#DB6E00'),
  procedure_blocks: style('#FF6680', '#FF4D6A', '#FF3355'),
  colour_blocks: style('#CF63CF', '#C94FC9', '#BD42BD'),
  hat_blocks: {...style('#FFBF00', '#E6AC00', '#CC9900'), hat: 'cap'},
};

const categoryStyles = {
  logic_category: {colour: '#4C97FF'},
  loop_category: {colour: '#FFAB19'},
  math_category: {colour: '#59C059'},
  text_category: {colour: '#9966FF'},
  io_category: {colour: '#9966FF'},
  list_category: {colour: '#FF661A'},
  variable_category: {colour: '#FF8C1A'},
  procedure_category: {colour: '#FF6680'},
  code_category: {colour: '#8C8C8C'},
};

const fontStyle = {family: '"Segoe UI", system-ui, -apple-system, sans-serif', weight: '500', size: 12};

const themes = {
  dark: Blockly.Theme.defineTheme('vide-dark', {
    base: Blockly.Themes.Classic,
    blockStyles,
    categoryStyles,
    fontStyle,
    componentStyles: {
      workspaceBackgroundColour: '#1e1f22',
      toolboxBackgroundColour: '#2b2d30',
      toolboxForegroundColour: '#dfe1e5',
      flyoutBackgroundColour: '#26282b',
      flyoutForegroundColour: '#dfe1e5',
      flyoutOpacity: 0.97,
      scrollbarColour: '#6b6f76',
      scrollbarOpacity: 0.5,
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.3,
      cursorColour: '#d0d0d0',
    },
  }),
  light: Blockly.Theme.defineTheme('vide-light', {
    base: Blockly.Themes.Classic,
    blockStyles,
    categoryStyles,
    fontStyle,
    componentStyles: {
      workspaceBackgroundColour: '#f9f9fb',
      toolboxBackgroundColour: '#ffffff',
      toolboxForegroundColour: '#1f2328',
      flyoutBackgroundColour: '#eef0f3',
      flyoutForegroundColour: '#1f2328',
      flyoutOpacity: 0.97,
      scrollbarColour: '#a0a4ab',
      scrollbarOpacity: 0.5,
      insertionMarkerColour: '#000000',
      insertionMarkerOpacity: 0.2,
    },
  }),
};

export const blocklyTheme = (name) => themes[name] || themes.dark;
export const monacoTheme = (name) => (name === 'light' ? 'vs' : 'vs-dark');

export function applyPageTheme(name) {
  document.documentElement.dataset.theme = name === 'light' ? 'light' : 'dark';
}
