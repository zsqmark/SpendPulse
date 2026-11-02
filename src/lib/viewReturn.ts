/**
 * Where a "go back" should land, and when it is allowed to happen at all.
 *
 * The app is one screen with tabs, not a router: there is no URL to return to and no
 * browser history entry per tab. So the journey is recorded by hand - the tab the reader
 * was on when a jump took them somewhere else - and replayed when the job is done.
 *
 * Kept free of React so the rules can be tested, the same way invoiceFocus.ts is.
 */

/** Why the panel was dismissed. Decides whether the close moves the reader. */
export type CloseReason = 'complete' | 'cancel';

export interface ReturnOrigin {
  /** The tab to land on. */
  tab: string;
  /** What to call it on the button: "Trends", not "trends". */
  label: string;
  /** How far down that page was scrolled when the jump happened. */
  scrollY: number;
}

export const TAB_LABELS: Record<string, string> = {
  invoices: 'Invoices',
  alerts: 'Alerts',
  catalog: 'Catalog',
  alignment: 'Alignment Review',
  trends: 'Trends',
  vendors: 'Suppliers',
  chat: 'Copilot',
};

export function tabLabel(tab: string): string {
  return TAB_LABELS[tab] ?? tab;
}

/**
 * The origin a jump creates.
 *
 * A jump inside the page the reader is already on is not a journey - following a second
 * invoice link while reading the invoices tab must not overwrite the origin that brought
 * them there, or the original way back would be lost.
 */
export function buildReturnOrigin(
  fromTab: string,
  toTab: string,
  existing: ReturnOrigin | null,
  scrollY: number
): ReturnOrigin | null {
  if (!fromTab || !toTab || fromTab === toTab) return existing;
  return { tab: fromTab, label: tabLabel(fromTab), scrollY: Number.isFinite(scrollY) ? scrollY : 0 };
}

/**
 * Only finishing the job goes back.
 *
 * Pressing Escape, clicking the backdrop or hitting a cancel button all mean "get this
 * out of my way, I am still working on this page" - taking them to another tab would
 * throw away the very work they stayed for.
 */
export function goesBackOnClose(reason: CloseReason): boolean {
  return reason === 'complete';
}

/** The tab the app opens on. Also where a close falls back to. */
export const HOME_TAB = 'invoices';

/**
 * The tab to show when the reader has nowhere to go back to.
 *
 * New tab, shared link or a refresh: everything recorded this session is gone, so the
 * home page is the honest destination rather than a blank one.
 */
export function fallbackTab(
  currentTab: string | null | undefined,
  homeTab: string = HOME_TAB
): string {
  return currentTab || homeTab;
}

/**
 * Where a close should land, taking the fallback into account.
 *
 * A cancel never moves the reader. Neither does a close with no origin behind it - someone
 * who arrived by a direct link, in a new tab, or after a refresh has nowhere to go back to,
 * so the page they are already on is the answer.
 */
export function resolveReturnTarget(
  origin: ReturnOrigin | null,
  reason: CloseReason,
  currentTab: string
): { tab: string; wentBack: boolean } {
  if (!origin || !goesBackOnClose(reason)) {
    return { tab: fallbackTab(currentTab), wentBack: false };
  }
  return { tab: origin.tab, wentBack: true };
}
