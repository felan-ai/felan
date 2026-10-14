import {
  UiHintSchema, parseSchema,
  type UiActionRequest, type UiFormAnswer, type UiForm, type UiHint, type UiPresentation,
} from '@felan-ai/session-protocol';

export interface UiHintRenderer {
  form?(form: UiForm, signal: AbortSignal): Promise<UiFormAnswer | undefined>;
  updatePresentation?(element: UiPresentation, signal: AbortSignal): boolean;
  presentation?(element: UiPresentation, signal: AbortSignal): Promise<UiActionRequest | undefined>;
}

export class UiHintRenderers {
  private readonly updates = new WeakMap<AbortSignal, UiPresentation>();
  private readonly renderers = new Map<string, { renderer: UiHintRenderer }>();

  register(hint: UiHint, renderer: UiHintRenderer): () => void {
    const key = this.key(parseSchema(UiHintSchema, hint));
    if (this.renderers.has(key)) throw new Error('Hint renderer is already registered.');
    const entry = { renderer };
    this.renderers.set(key, entry);
    return () => { if (this.renderers.get(key) === entry) this.renderers.delete(key); };
  }

  get(hint: UiHint | undefined): UiHintRenderer | undefined {
    return hint && this.renderers.get(this.key(hint))?.renderer;
  }

  updatePresentation(element: UiPresentation, signal: AbortSignal): boolean {
    if (signal.aborted || !this.get(element.hint)?.updatePresentation?.(element, signal)) return false;
    this.updates.set(signal, element);
    return true;
  }

  currentPresentation(element: UiPresentation, signal: AbortSignal): UiPresentation {
    return this.updates.get(signal) ?? element;
  }

  private key(hint: UiHint): string { return JSON.stringify([hint.id, hint.version]); }
}
