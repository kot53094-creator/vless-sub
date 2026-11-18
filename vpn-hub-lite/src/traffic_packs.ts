/**
 * Пакеты докупки трафика.
 *
 * Пакет — это не тариф: он не даёт дней, а увеличивает квоту. Поэтому у него
 * своя таблица и своё представление в PayPlan (days = 0).
 */

import { many } from "./db";
import type { Env } from "./types";
import type { PayPlan } from "./pay/types";

export interface TrafficPack {
  code: string;
  gb: number;
  price_rub: number;
  title: string;
}

/**
 * Список пакетов. Если миграция 0025 ещё не применена, возвращаем пустой
 * список: витрина просто не покажет докупку, а не упадёт с ошибкой.
 */
export async function listTrafficPacks(env: Env): Promise<TrafficPack[]> {
  try {
    const rows = await many<TrafficPack>(
      env,
      `SELECT code, gb, price_rub, title FROM traffic_packs
        WHERE active = 1 ORDER BY sort, id`,
    );
    return rows.filter((row) => row.gb > 0 && row.price_rub >= 0);
  } catch {
    return [];
  }
}

/** Пакет как объект кассы: ноль дней, цена в рублях. */
export function packAsPlan(pack: TrafficPack): PayPlan {
  return {
    code: pack.code,
    title: pack.title || `+${pack.gb} ГБ`,
    days: 0,
    price_rub: pack.price_rub,
  };
}

export async function findPack(env: Env, code: string): Promise<TrafficPack | null> {
  const packs = await listTrafficPacks(env);
  return packs.find((pack) => pack.code === code) ?? null;
}
