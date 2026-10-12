// Test-only text projection of the CSI operations emitted by this pinned TUI.
// Raw ANSI remains authoritative for color and unsupported terminal behavior.
import { visibleWidth } from '@earendil-works/pi-tui';

export class ManualTerminalGrid {
  private cells: string[][] = [];
  private x = 0;
  private y = 0;
  private saved: [number, number] = [0, 0];
  private pending = '';
  private wrap = true;
  frames = 0;
  clears = 0;
  screen = '';
  screenColumns = 0;
  screenRows = 0;

  constructor(public columns: number, public rows: number) { this.reset(); }
  resize(columns: number, rows: number): void { this.columns = columns; this.rows = rows; this.reset(); }
  private reset(): void { this.cells = Array.from({ length: this.rows }, () => Array(this.columns).fill(' ')); this.x = 0; this.y = 0; }
  private clamp(): void { this.x = Math.max(0, Math.min(this.columns - 1, this.x)); this.y = Math.max(0, Math.min(this.rows - 1, this.y)); }
  private lineFeed(): void {
    if (++this.y >= this.rows) { this.cells.shift(); this.cells.push(Array(this.columns).fill(' ')); this.y = this.rows - 1; }
  }
  private commit(): void {
    this.screen = this.cells.map(row => row.join('')).join('\n');
    this.screenColumns = this.columns; this.screenRows = this.rows; this.frames++;
  }

  feed(data: string): void {
    this.pending += data;
    while (this.pending.length) {
      if (this.pending.startsWith('\x1b[')) {
        const match = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/u.exec(this.pending);
        if (!match) { if (this.pending.length > 256) throw new Error('Unterminated CSI'); return; }
        this.pending = this.pending.slice(match[0].length);
        this.csi(match[1]!, match[2]!, match[3]!); continue;
      }
      if (/^\x1b[\]P_^]/u.test(this.pending)) {
        const end = /\x07|\x1b\\/u.exec(this.pending);
        if (!end) { if (this.pending.length > 64 * 1024) throw new Error('Unterminated terminal string'); return; }
        this.pending = this.pending.slice(end.index + end[0].length); continue;
      }
      if (this.pending.startsWith('\x1b')) {
        if (this.pending.length < 2) return;
        const code = this.pending[1];
        if (code === '(' || code === ')') { if (this.pending.length < 3) return; this.pending = this.pending.slice(3); continue; }
        this.pending = this.pending.slice(2);
        if (code === '7') this.saved = [this.x, this.y];
        else if (code === '8') { [this.x, this.y] = this.saved; this.clamp(); }
        else if (code === 'D') this.lineFeed();
        else if (code === 'M') this.y = Math.max(0, this.y - 1);
        else if (code === 'E') { this.x = 0; this.lineFeed(); }
        else if (code !== '=' && code !== '>') throw new Error(`Unsupported escape: ${JSON.stringify(code)}`);
        continue;
      }
      const point = this.pending.codePointAt(0)!;
      const char = String.fromCodePoint(point); this.pending = this.pending.slice(char.length);
      if (char === '\r') this.x = 0;
      else if (char === '\n') this.lineFeed();
      else if (char === '\b') this.x = Math.max(0, this.x - 1);
      else if (char === '\t') this.x = Math.min(this.columns - 1, (Math.floor(this.x / 8) + 1) * 8);
      else if (point >= 32 && point !== 127) {
        const width = visibleWidth(char);
        if (width === 0) { if (this.x > 0) this.cells[this.y]![this.x - 1] = (this.cells[this.y]![this.x - 1] ?? '') + char; continue; }
        if (this.x + width > this.columns) { if (this.wrap) { this.x = 0; this.lineFeed(); } else this.x = this.columns - width; }
        this.cells[this.y]![this.x] = char;
        if (width === 2) this.cells[this.y]![this.x + 1] = '';
        this.x += width;
      }
    }
  }

  private csi(params: string, intermediate: string, command: string): void {
    const numbers = params.replace(/^[?<=>]/u, '').split(';').map(value => Number(value) || 0);
    const first = numbers[0] || 1;
    if (command === 'm' || ['c', 'n', 't', 'q'].includes(command)) return;
    if (command === 'h' || command === 'l') {
      if (params === '?7') this.wrap = command === 'h';
      if (params === '?1049' && command === 'h') this.reset();
      if (params === '?2026' && command === 'l') this.commit();
      return;
    }
    if (intermediate) throw new Error(`Unsupported CSI: ${params}${intermediate}${command}`);
    if (command === 'H' || command === 'f') { this.y = first - 1; this.x = (numbers[1] || 1) - 1; }
    else if (command === 'A') this.y -= first;
    else if (command === 'B' || command === 'e') this.y += first;
    else if (command === 'C' || command === 'a') this.x += first;
    else if (command === 'D') this.x -= first;
    else if (command === 'E') { this.y += first; this.x = 0; }
    else if (command === 'F') { this.y -= first; this.x = 0; }
    else if (command === 'G' || command === '`') this.x = first - 1;
    else if (command === 'd') this.y = first - 1;
    else if (command === 'J') {
      const mode = numbers[0];
      if (mode === 2) { this.cells = Array.from({ length: this.rows }, () => Array(this.columns).fill(' ')); this.clears++; }
      else if (mode === 0) { this.cells[this.y]!.fill(' ', this.x); for (let row = this.y + 1; row < this.rows; row++) this.cells[row]!.fill(' '); }
      else if (mode === 1) { for (let row = 0; row < this.y; row++) this.cells[row]!.fill(' '); this.cells[this.y]!.fill(' ', 0, this.x + 1); }
      else if (mode !== 3) throw new Error(`Unsupported erase mode: ${mode}`);
    } else if (command === 'K') {
      const mode = numbers[0];
      this.cells[this.y]!.fill(' ', mode === 0 ? Math.min(this.x, this.columns) : 0, mode === 1 ? Math.min(this.x + 1, this.columns) : this.columns);
    } else if (command === 's') this.saved = [this.x, this.y];
    else if (command === 'u') { if (/^[><=]/u.test(params)) return; [this.x, this.y] = this.saved; }
    else if (command === 'X') this.cells[this.y]!.fill(' ', this.x, Math.min(this.columns, this.x + first));
    else throw new Error(`Unsupported CSI: ${params}${command}`);
    this.clamp();
  }
}
