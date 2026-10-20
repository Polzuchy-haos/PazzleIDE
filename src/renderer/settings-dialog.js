// Диалог настроек: внешний вид, папка утилит PVM, плата.

export function openSettingsDialog({settings, tools, chooseFolder, onSave}) {
  const dialog = document.getElementById('settings-dialog');
  const form = document.getElementById('settings-form');
  form.theme.value = settings.theme;
  form.renderer.value = settings.renderer;
  form.fontSize.value = settings.fontSize;
  form.pvmTools.value = settings.pvmTools || '';
  form.port.value = settings.port || '';
  form.baud.value = String(settings.baud || 9600);
  form.rawOutput.checked = !!settings.rawOutput;

  const status = document.getElementById('settings-tools-status');
  status.textContent = tools?.dir
    ? `Сейчас используются: ${tools.dir} (${tools.source})${tools.missing.length ? ` — нет: ${tools.missing.join(', ')}` : ''}`
    : 'Утилиты PVM не найдены — укажите папку.';

  document.getElementById('settings-browse').onclick = async () => {
    const dir = await chooseFolder();
    if (dir) form.pvmTools.value = dir;
  };

  dialog.onclose = () => {
    if (dialog.returnValue !== 'ok') return;
    onSave({
      theme: form.theme.value,
      renderer: form.renderer.value,
      fontSize: Math.min(28, Math.max(10, Number(form.fontSize.value) || 14)),
      pvmTools: form.pvmTools.value.trim(),
      port: form.port.value.trim() || 'COM3',
      baud: Number(form.baud.value) || 9600,
      rawOutput: form.rawOutput.checked,
    });
  };
  dialog.returnValue = '';
  dialog.showModal();
}
