"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { IssuedTicket } from "@/components/world-id-gate";
import { useKuraUser } from "@/hooks/use-kura-user";
import { useNow } from "@/hooks/use-now";

/** A cached ticket is used only while it has more than this left, so it cannot expire between simulation and mining. */
const MARGIN_SEC = 60;

/** Whether `issued` is a usable ticket for `wallet` at `nowSec`. */
export function ticketValid(issued: IssuedTicket | null, wallet: string | null, nowSec: number): boolean {
  return !!issued && !!wallet && issued.ticket.subject.toLowerCase() === wallet.toLowerCase() && Number(issued.ticket.expiresAt) > nowSec + MARGIN_SEC;
}

// localStorage, with an in-memory copy for when storage is unavailable (private mode): the ticket then lasts the session.
const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();
const EVENT = "kura-ticket";

function readRaw(key: string | null): string | null {
  if (!key) return null;
  if (memory.has(key)) return memory.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null) {
  memory.set(key, value);
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the in-memory copy serves this session */
  }
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith("kura.ticket.")) {
      memory.delete(e.key);
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, cb);
  };
}

function parse(raw: string | null): IssuedTicket | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IssuedTicket;
  } catch {
    return null;
  }
}

/**
 * The World ID ticket for `action`, cached in localStorage under `kura.ticket.<action>.<wallet>` so one verification
 * covers every bid for its 24 hours. `issued` is null unless the cached ticket is valid for `wallet` (default: the
 * connected wallet).
 */
export function useTicket(action: "bid" | "release", wallet?: string | null) {
  const user = useKuraUser();
  const address = wallet !== undefined ? wallet : user.address;
  const key = address ? `kura.ticket.${action}.${address.toLowerCase()}` : null;
  const raw = useSyncExternalStore(subscribe, () => readRaw(key), () => null);
  const issued = useMemo(() => parse(raw), [raw]);
  const now = useNow(30_000);
  const valid = ticketValid(issued, address, now);

  const save = useCallback((t: IssuedTicket) => { if (key) writeRaw(key, JSON.stringify(t)); }, [key]);
  const clear = useCallback(() => { if (key) writeRaw(key, null); }, [key]);
  return { issued: valid ? issued : null, valid, save, clear };
}
