// 会话卡片预览:从 capture-pane 文本中滤掉 Claude Code 的界面噪音,留末尾正文。
// 纯函数,便于测试。
// 含任何框线/横幅字符的行、状态区行,一律视为噪音(claude 正文极少用这些字符,预览宁缺勿噪)
const NOISE = /[─╭╰╮╯│▛▜▝▘█▐▌░]|bypass permissions|^\[Fable|^Context|^Usage|Auto-updating|shift\+tab|^\d+ MCPs?|^[✻✽✢✳·✶✦✧*✘✗✓]\s|ed for \d+m?s\b|^[❯›]|Welcome back|esc to interrupt|Auto-update/;

// Claude Code 状态感知:从当前屏幕文本推断会话状态。
// 顺序要紧:权限对话框出现时旋转器已消失,所以先判 waiting。
export function detectClaudeState(text) {
  const s = String(text);
  if (/Do you want|❯\s*1\.|Enter to confirm/.test(s)) return 'waiting';   // 等人确认
  if (/esc to interrupt|ctrl\+b to run in background/.test(s)) return 'working'; // 正在干活
  return 'idle';
}

export function previewFromCapture(text, { maxLines = 2, maxChars = 64 } = {}) {
  const content = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l));
  return content
    .slice(-maxLines)
    .map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l));
}
