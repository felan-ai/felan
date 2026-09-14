// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CartPage from '@/app/cart/page';
import LoginPage from '@/app/page';
import CheckoutCompletePage from '@/app/checkout-complete/page';
import Header from '@/components/header';

type StorageSnapshot = Map<string, string>;

const navigationTargets = vi.hoisted((): string[] => []);

vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const capture = (target: string) => navigationTargets.push(new URL(target, 'http://localhost/').pathname);
  return {
    ...actual,
    redirect: capture,
    permanentRedirect: capture,
    useRouter: () => ({
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      push: capture,
      refresh: vi.fn(),
      replace: capture,
    }),
  };
});

const originalImprovedCheckout = process.env.NEXT_PUBLIC_IMPROVED_CHECKOUT;
const originalAddToCartBug = process.env.NEXT_PUBLIC_ADD_TO_CART_BUG;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let restoreLocationNavigation: (() => void) | undefined;

beforeEach(() => {
  const local = createStorage();
  const session = createStorage();
  Object.defineProperties(window, {
    localStorage: { configurable: true, value: local },
    sessionStorage: { configurable: true, value: session },
  });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  clearCookies();
  document.body.replaceChildren();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  navigationTargets.length = 0;
  restoreLocationNavigation = trackJsdomNavigation();
  const consoleError = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args.some((value) => String(value).includes('Not implemented: navigation'))) return;
    consoleError(...args);
  });
});

afterEach(async () => {
  await unmount();
  restoreLocationNavigation?.();
  restoreLocationNavigation = undefined;
  localStorage.clear();
  sessionStorage.clear();
  clearCookies();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreEnv('NEXT_PUBLIC_IMPROVED_CHECKOUT', originalImprovedCheckout);
  restoreEnv('NEXT_PUBLIC_ADD_TO_CART_BUG', originalAddToCartBug);
});

describe('authenticated Storzy flow', () => {
  it('rejects invalid credentials without creating an authenticated session', async () => {
    const fetchMock = vi.fn(async () => response({ error: 'Invalid credentials' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await render(<LoginPage />);

    await fillLogin('test_user', 'wrong');
    await submit(requiredElement('form'));

    await waitFor(() => expect(document.body.textContent).toMatch(/invalid|error|unable/i));
    expect(requestsTo(fetchMock, '/api/auth/login').length).toBeLessThanOrEqual(1);
    expect(browserStorage()).toEqual(new Map());
    expect(navigationTargets).toEqual([]);
  });

  it('clears the authenticated state created by login on logout', async () => {
    const { storage } = await authenticate();
    expect(storage.size).toBeGreaterThan(0);

    await render(<Header cartCount={2} currentUser="test_user" />);
    const logout = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Logout');
    expect(logout).toBeDefined();
    await click(logout!);

    for (const key of storage.keys()) expect(readStorageKey(key)).toBeNull();
  });

  it.each([
    ['cart', () => render(<CartPage />)],
    ['completion', () => render(<CheckoutCompletePage />)],
  ])('keeps unauthenticated customers out of the %s page', async (_page, renderPage) => {
    const navigationStart = navigationTargets.length;
    await renderPage();
    await expectOnlyNavigation('/', navigationStart);
  });

  for (const improved of [false, true]) {
    const variant = improved ? 'improved' : 'standard';

    it(`${variant} checkout preserves its unauthenticated login guard`, async () => {
      const fetchMock = vi.fn(async () => response({ error: 'unexpected request' }, 500));
      vi.stubGlobal('fetch', fetchMock);
      const navigationStart = navigationTargets.length;
      await renderCheckoutPage(improved);

      await expectOnlyNavigation('/', navigationStart);
      expect(requestsTo(fetchMock, '/api/orders')).toHaveLength(0);
    });

    it(`${variant} checkout guards an empty cart without creating an order`, async () => {
      await authenticate();
      const fetchMock = vi.fn(async () => response({ error: 'unexpected request' }, 500));
      vi.stubGlobal('fetch', fetchMock);
      const navigationStart = navigationTargets.length;
      await renderCheckout(improved);
      await fillCheckout(improved);
      const messagesBefore = visibleMessages();
      const hasExistingFeedback = [...messagesBefore].some(isEmptyCartFeedback);
      await submit(requiredElement('form'));

      await waitFor(() => {
        const hasInlineFeedback = [...visibleMessages()]
          .some((message) => !messagesBefore.has(message) && isEmptyCartFeedback(message));
        const attemptedNavigation = navigationTargets.slice(navigationStart);
        const returnedToCart = attemptedNavigation.length > 0
          && attemptedNavigation.every((target) => target === '/cart');
        expect(hasExistingFeedback || hasInlineFeedback || returnedToCart).toBe(true);
      });
      expect(navigationTargets.slice(navigationStart).every((target) => target === '/cart')).toBe(true);
      expect(requestsTo(fetchMock, '/api/orders')).toHaveLength(0);
    });

    it(`${variant} checkout validates required fields before creating an order`, async () => {
      await authenticate();
      await addProductToCart(1);
      const fetchMock = vi.fn(async () => response({ error: 'unexpected request' }, 500));
      vi.stubGlobal('fetch', fetchMock);
      await renderCheckout(improved);
      const form = requiredElement<HTMLFormElement>('form');
      const messagesBefore = visibleMessages();

      await requestSubmit(form);

      await waitFor(() => {
        const nativeValidationBlocked = invalidFormControls(form).length > 0;
        const newValidationFeedback = [...visibleMessages()].some((message) => (
          !messagesBefore.has(message)
          && /required|missing|invalid|enter|provide|select|choose/i.test(message)
        ));
        expect(nativeValidationBlocked || newValidationFeedback).toBe(true);
      });
      expect(requestsTo(fetchMock, '/api/orders')).toHaveLength(0);
      await expectCart(false);
    });

    it(`${variant} checkout preserves the cart and recovers after an API failure`, async () => {
      const { token } = await authenticate();
      await addProductToCart(2);
      const order = createOrder('ord_recovered');
      let submissionCount = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = requestPath(input);
        if (path === `/api/orders/${order.id}`) return response({ order }, 200);
        if (path !== '/api/orders') return response({ error: 'Unexpected request' }, 404);
        submissionCount += 1;
        return submissionCount === 1
          ? response({ error: 'Order failed' }, 503)
          : response({ order }, 201);
      });
      vi.stubGlobal('fetch', fetchMock);
      await renderCheckout(improved);
      await fillCheckout(improved);
      const failureNavigationStart = navigationTargets.length;
      await submit(requiredElement('form'));

      await waitFor(() => expect(document.body.textContent).toMatch(/unable|failed|error|try again/i));
      expect(navigationTargets.slice(failureNavigationStart)).toEqual([]);
      expect(requiredElement<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
      assertOrderRequests(fetchMock, token);
      await expectCart(false);

      await renderCheckout(improved);
      await fillCheckout(improved);
      const completionNavigationStart = navigationTargets.length;
      await submit(requiredElement('form'));
      await expectOnlyNavigation('/checkout-complete', completionNavigationStart);
      assertOrderRequests(fetchMock, token);
      await expectCart(true);
      await expectReceipt(order);
    });

    it(`${variant} checkout submits a valid order, clears only on success, and renders the receipt`, async () => {
      const { token } = await authenticate();
      await addProductToCart(2);
      const order = createOrder(`ord_${variant}`);
      let resolveOrder!: (value: Response) => void;
      const pendingOrder = new Promise<Response>((resolve) => { resolveOrder = resolve; });
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const path = requestPath(input);
        if (path === '/api/orders') return pendingOrder;
        if (path === `/api/orders/${order.id}`) return Promise.resolve(response({ order }, 200));
        return Promise.resolve(response({ error: 'Unexpected request' }, 404));
      });
      vi.stubGlobal('fetch', fetchMock);
      await renderCheckout(improved);
      await fillCheckout(improved);
      const completionNavigationStart = navigationTargets.length;

      const form = requiredElement<HTMLFormElement>('form');
      await submit(form);
      await waitFor(() => expect(requestsTo(fetchMock, '/api/orders').length).toBeGreaterThan(0));
      assertOrderRequests(fetchMock, token);
      await expectCart(false);

      await act(async () => {
        resolveOrder(response({ order }, 201));
        await pendingOrder;
        await Promise.resolve();
      });
      await expectOnlyNavigation('/checkout-complete', completionNavigationStart);
      assertOrderRequests(fetchMock, token);
      await expectCart(true);
      await expectReceipt(order);
    });
  }

  it.each([
    ['disabled', 'false', 1],
    ['enabled', 'true', 0],
  ])('preserves add-to-cart bug mode when %s', async (_label, flag, expectedQuantity) => {
    await authenticate();
    process.env.NEXT_PUBLIC_ADD_TO_CART_BUG = flag;
    await addProductToCart(1, false);
    await expectCart(expectedQuantity === 0);
  });
});

async function authenticate() {
  const token = 'opaque-session-token-from-login';
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (requestPath(input) !== '/api/auth/login') throw new Error(`Unexpected request: ${String(input)}`);
    return response({ token, user: 'test_user' }, 200);
  });
  vi.stubGlobal('fetch', fetchMock);
  await render(<LoginPage />);
  await fillLogin('test_user', 'password');
  await submit(requiredElement('form'));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const values = [...browserStorage().values()].join('\n');
    expect(values).toContain('test_user');
    expect(values).toContain(token);
  });
  const request = fetchMock.mock.calls[0];
  expect(requestPath(request?.[0])).toBe('/api/auth/login');
  const body = JSON.parse(String(request?.[1]?.body)) as Record<string, string>;
  expect(body).toMatchObject({ username: 'test_user', password: 'password' });
  return { token, storage: browserStorage() };
}

async function renderCheckout(improved: boolean) {
  await renderCheckoutPage(improved);
  requiredElement<HTMLFormElement>('form');
  expect(fieldFor(/country/i) !== undefined).toBe(improved);
  expect(fieldFor(/shipping method/i) !== undefined).toBe(improved);
}

async function renderCheckoutPage(improved: boolean) {
  process.env.NEXT_PUBLIC_IMPROVED_CHECKOUT = String(improved);
  vi.resetModules();
  const { default: CheckoutPage } = await import('@/app/checkout/page');
  await render(<CheckoutPage />);
}

async function fillLogin(username: string, password: string) {
  const usernameField = fieldFor(/user(?:name)?|login/i)
    ?? document.querySelector<HTMLInputElement>(
      'input[autocomplete="username"], input[name*="user" i], input:not([type="password"]):not([type="hidden"])',
    );
  const passwordField = fieldFor(/password/i)
    ?? document.querySelector<HTMLInputElement>('input[type="password"], input[autocomplete="current-password"]');
  expect(usernameField).toBeInstanceOf(HTMLInputElement);
  expect(passwordField).toBeInstanceOf(HTMLInputElement);
  expect(usernameField).not.toBe(passwordField);
  await setValue(usernameField!, username);
  await setValue(passwordField!, password);
}

async function fillCheckout(improved: boolean) {
  await setControlValue(requiredField(/first name/i), 'Ada');
  await setControlValue(requiredField(/last name/i), 'Lovelace');
  await setControlValue(requiredField(/postal code|zip code/i), '12345');
  if (!improved) return;

  await setControlValue(requiredField(/country/i), 'us');
  await setControlValue(requiredField(/shipping method/i), 'standard');
}

function assertOrderRequests(fetchMock: ReturnType<typeof vi.fn>, token: string) {
  const requests = requestsTo(fetchMock, '/api/orders');
  expect(requests.length).toBeGreaterThan(0);
  for (const [, init] of requests) {
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      items: [{ productId: 1, quantity: 2 }],
      customer: { firstName: 'Ada', lastName: 'Lovelace', postalCode: '12345' },
    });
  }
}

async function addProductToCart(quantity: number, setWorkingFlag = true) {
  if (setWorkingFlag) process.env.NEXT_PUBLIC_ADD_TO_CART_BUG = 'false';
  vi.resetModules();
  const { default: InventoryPage } = await import('@/app/inventory/page');
  vi.stubGlobal('fetch', vi.fn(async () => response({
    products: [{ id: 1, name: 'Explorer Backpack', description: 'Pack', price: 29.99, image: '' }],
  }, 200)));
  await render(<InventoryPage />);
  await waitFor(() => expect(document.body.textContent).toContain('Explorer Backpack'));
  const add = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.match(/add.*cart/i));
  expect(add).toBeDefined();
  await click(add!);

  if (quantity <= 1) return;
  await render(<CartPage />);
  await waitFor(() => expect(document.body.textContent).toContain('Explorer Backpack'));
  const increase = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '+');
  expect(increase).toBeDefined();
  for (let count = 1; count < quantity; count++) await click(increase!);
}

async function expectCart(empty: boolean) {
  await render(<CartPage />);
  await waitFor(() => {
    const text = document.body.textContent ?? '';
    if (empty) expect(text).toMatch(/cart is empty/i);
    else expect(text).toContain('Explorer Backpack');
  });
}

async function expectReceipt(order: ReturnType<typeof createOrder>) {
  await render(<CheckoutCompletePage />);
  await waitFor(() => {
    const text = document.body.textContent ?? '';
    expect(text).toContain(order.id);
    expect(text).toContain('Ada');
    expect(text).toContain('Lovelace');
    expect(text).toContain('59.98');
  });
}

function createOrder(id: string) {
  return {
    id,
    items: [{ productId: 1, quantity: 2 }],
    customer: { firstName: 'Ada', lastName: 'Lovelace', postalCode: '12345' },
    total: 59.98,
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function response(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => structuredClone(body),
  } as Response;
}

async function render(node: ReactNode) {
  await unmount();
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
    await Promise.resolve();
  });
}

async function unmount() {
  if (!root) return;
  const mountedRoot = root;
  root = undefined;
  await act(async () => { mountedRoot.unmount(); });
  container = undefined;
}

async function setValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  await act(async () => {
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function setControlValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  preferredValue: string,
) {
  if (element instanceof HTMLSelectElement) {
    const value = [...element.options].find((option) => option.value)?.value ?? preferredValue;
    await setValue(element, value);
    return;
  }
  if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
    await click(element);
    return;
  }
  await setValue(element, preferredValue);
}

async function submit(form: Element) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function requestSubmit(form: HTMLFormElement) {
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw lastError;
}

function requiredElement<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function requiredField(label: RegExp): FormField {
  const field = fieldFor(label);
  if (!field) throw new Error(`Missing form field: ${label}`);
  return field;
}

function fieldFor(label: RegExp): FormField | undefined {
  const form = document.querySelector('form');
  if (!form) return undefined;
  for (const labelElement of form.querySelectorAll('label')) {
    if (!label.test(labelElement.textContent ?? '')) continue;
    const associated = labelElement.htmlFor ? document.getElementById(labelElement.htmlFor) : undefined;
    const field = associated ?? labelElement.querySelector('input, select, textarea')
      ?? labelElement.parentElement?.querySelector('input, select, textarea');
    if (field instanceof HTMLInputElement
      || field instanceof HTMLSelectElement
      || field instanceof HTMLTextAreaElement) return field;
  }
  for (const field of form.querySelectorAll<FormField>('input, select, textarea')) {
    const description = [field.id, field.getAttribute('name'), field.getAttribute('aria-label'), field.getAttribute('placeholder')]
      .filter(Boolean)
      .join(' ');
    if (label.test(description)) return field;
  }
  return undefined;
}

function browserStorage(): StorageSnapshot {
  const snapshot = new Map<string, string>();
  for (const [prefix, storage] of [['local', localStorage], ['session', sessionStorage]] as const) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key) snapshot.set(`${prefix}:${key}`, storage.getItem(key) ?? '');
    }
  }
  for (const cookie of document.cookie.split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0) continue;
    const key = cookie.slice(0, separator).trim();
    if (key) snapshot.set(`cookie:${key}`, decodeURIComponent(cookie.slice(separator + 1)));
  }
  return snapshot;
}

function visibleMessages() {
  return new Set([...document.body.querySelectorAll<HTMLElement>('*')]
    .filter((element) => element.children.length === 0 && !element.closest('button, label'))
    .map((element) => element.textContent?.replace(/\s+/gu, ' ').trim() ?? '')
    .filter(Boolean));
}

function isEmptyCartFeedback(message: string) {
  return /empty|no (?:cart )?(?:items|products)|nothing in|add (?:an? |some )?(?:item|product)|cannot .*checkout/iu.test(message);
}

function requestsTo(fetchMock: ReturnType<typeof vi.fn>, path: string) {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input) === path);
}

function requestPath(input: unknown) {
  if (input instanceof Request) return new URL(input.url).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(String(input), window.location.href).pathname;
}

async function expectOnlyNavigation(path: string, startIndex: number) {
  await waitFor(() => {
    const targets = navigationTargets.slice(startIndex);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((target) => target === path)).toBe(true);
  });
}

function invalidFormControls(form: HTMLFormElement) {
  return [...form.elements].filter((element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => (
    element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  )).filter((element) => !element.checkValidity());
}

type JsdomUrlRecord = { path?: unknown[] };
type JsdomLocationImplementation = {
  _locationObjectNavigate: (url: JsdomUrlRecord, options?: unknown) => unknown;
};

function trackJsdomNavigation() {
  const implementation = Reflect.ownKeys(window.location)
    .map((key) => Reflect.get(window.location, key) as unknown)
    .find((value): value is JsdomLocationImplementation => (
      typeof value === 'object'
      && value !== null
      && typeof Reflect.get(value, '_locationObjectNavigate') === 'function'
    ));
  if (!implementation) throw new Error('Unable to instrument jsdom navigation');

  const originalNavigate = implementation._locationObjectNavigate;
  // jsdom reports cross-document navigation without updating window.location, so capture its parsed destination.
  implementation._locationObjectNavigate = function captureNavigation(url, options) {
    navigationTargets.push(pathnameFromJsdomUrl(url));
    return originalNavigate.call(this, url, options);
  };
  return () => { implementation._locationObjectNavigate = originalNavigate; };
}

function pathnameFromJsdomUrl(url: JsdomUrlRecord) {
  if (!Array.isArray(url.path)) return '/';
  return `/${url.path.map(String).join('/')}`.replace(/\/{2,}/gu, '/');
}

function readStorageKey(namespacedKey: string) {
  const [scope, ...parts] = namespacedKey.split(':');
  const key = parts.join(':');
  if (scope === 'local') return localStorage.getItem(key);
  if (scope === 'session') return sessionStorage.getItem(key);
  return browserStorage().get(namespacedKey) ?? null;
}

function findStoredJson(predicate: (value: Record<string, unknown>) => boolean) {
  for (const value of browserStorage().values()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null && predicate(parsed as Record<string, unknown>)) return parsed;
    } catch {}
  }
  return undefined;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearCookies() {
  for (const cookie of document.cookie.split(';')) {
    const key = cookie.split('=', 1)[0]?.trim();
    if (key) document.cookie = `${key}=; Max-Age=0; path=/`;
  }
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(String(key)) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
}
