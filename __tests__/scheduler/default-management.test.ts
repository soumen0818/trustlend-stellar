import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the server-side contract invoker (no real RPC in tests) ───────────────
const mockGetAdminKeypair = vi.fn();
const mockGetLedgerTimeSecs = vi.fn();
const mockInvokeSigned = vi.fn();

vi.mock("@/lib/stellar/server-contract", () => ({
  getAdminKeypair: () => mockGetAdminKeypair(),
  getLedgerTimeSecs: () => mockGetLedgerTimeSecs(),
  invokeSigned: (...args: unknown[]) => mockInvokeSigned(...args),
  addr: (g: string) => ({ addr: g }),
  u32: (n: number) => ({ u32: n }),
  u64: (n: number) => ({ u64: n }),
  i128: (n: bigint) => ({ i128: n }),
  xlmToStroops: (xlm: number) => BigInt(Math.round(xlm * 10_000_000)),
}));

// ── Mock Supabase service-role client ──────────────────────────────────────────
const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  getServiceRoleClient: () => ({ from: mockFrom }),
}));

import {
  computeDaysOverdue,
  runDefaultManagement,
} from "@/lib/scheduler/default-management";

const DAY = 86_400;

// ── computeDaysOverdue (pure) ──────────────────────────────────────────────────

describe("computeDaysOverdue", () => {
  it("returns 0 when not yet overdue", () => {
    const now = 1_000_000_000;
    const due = new Date((now + DAY) * 1000).toISOString();
    expect(computeDaysOverdue(due, now)).toBe(0);
  });

  it("returns whole days overdue using ledger time", () => {
    const now = 1_000_000_000;
    const due = new Date((now - 30 * DAY) * 1000).toISOString();
    expect(computeDaysOverdue(due, now)).toBe(30);
  });

  it("floors partial days", () => {
    const now = 1_000_000_000;
    const due = new Date((now - (5 * DAY + 3600)) * 1000).toISOString();
    expect(computeDaysOverdue(due, now)).toBe(5);
  });
});

// ── runDefaultManagement ───────────────────────────────────────────────────────

/** A chain mock where every builder method returns itself; reads resolve via
 *  maybeSingle() (sequenced) and awaits resolve via the thenable. */
function makeSupabase(loans: unknown[], maybeSingleQueue: unknown[]) {
  const queue = [...maybeSingleQueue];
  const chain: Record<string, unknown> = {};
  const ret = () => chain;
  for (const m of ["select", "in", "not", "lt", "eq", "update"]) chain[m] = vi.fn(ret);
  chain.maybeSingle = vi.fn(() =>
    Promise.resolve(queue.length ? queue.shift() : { data: null })
  );
  // Awaiting the chain (the overdue-loans query) resolves to the loan list.
  Object.defineProperty(chain, "then", {
    get() {
      return (resolve: (v: unknown) => void) => resolve({ data: loans, error: null });
    },
  });
  mockFrom.mockReturnValue(chain);
  return chain;
}

const NOW = 1_700_000_000;

function overdueLoan(daysOverdue: number, overrides: Record<string, unknown> = {}) {
  return {
    id: "loan-1",
    borrower_id: "borrower-1",
    status: "active",
    principal_amount: 1000,
    repaid_amount: 0,
    due_at: new Date((NOW - daysOverdue * DAY) * 1000).toISOString(),
    defaulted_at: null,
    metadata: {},
    ...overrides,
  };
}

describe("runDefaultManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLedgerTimeSecs.mockResolvedValue(NOW);
    mockGetAdminKeypair.mockReturnValue(null); // DB-only mode (no on-chain calls)
  });

  it("skips loans still within the grace period", async () => {
    makeSupabase([overdueLoan(3)], []);
    const res = await runDefaultManagement();
    expect(res.scanned).toBe(1);
    expect(res.defaulted).toBe(0);
    expect(res.paidOut).toBe(0);
    expect(res.outcomes[0].skipped).toContain("grace period");
  });

  it("marks a past-grace loan defaulted (no payout before insurance threshold)", async () => {
    // maybeSingle order: ledger funding info, borrower wallet, loans metadata (for flag write)
    makeSupabase(
      [overdueLoan(30)],
      [
        { data: { metadata: { lenderAddress: "GLENDER", onchainLoanId: 7 } } },
        { data: { wallet_address: "GBORROWER" } },
        { data: { metadata: {} } },
      ]
    );
    const res = await runDefaultManagement();
    expect(res.defaulted).toBe(1);
    expect(res.paidOut).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.outcomes[0].actions).toContain("db:status=defaulted");
  });

  it("does not re-default an already-defaulted loan", async () => {
    makeSupabase(
      [overdueLoan(30, { defaulted_at: new Date(NOW * 1000).toISOString() })],
      [
        { data: { metadata: { lenderAddress: "GLENDER", onchainLoanId: 7 } } },
        { data: { wallet_address: "GBORROWER" } },
      ]
    );
    const res = await runDefaultManagement();
    expect(res.defaulted).toBe(0);
    expect(res.paidOut).toBe(0);
  });

  it("reports counts and never throws on a clean run", async () => {
    makeSupabase([], []);
    const res = await runDefaultManagement();
    expect(res).toMatchObject({ scanned: 0, defaulted: 0, paidOut: 0, failed: 0 });
    expect(res.ledgerTime).toBe(new Date(NOW * 1000).toISOString());
  });
});
