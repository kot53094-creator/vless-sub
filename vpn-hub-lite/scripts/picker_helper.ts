
export interface PickItem {
  id: number;
  country: string;
  label: string;
  latency: number | null;
}

/**
 * Список серверов, доступных конкретному человеку — тем же отбором, что
 * и подписка. Нужен боту, чтобы показать «Выбрать сервер» без расхождений
 * с тем, что реально приедет в Happ.
 */
export async function listAvailableServers(
  env: Env,
  user: UserRow,
  isAdmin: boolean,
  limit = 10,
): Promise<PickItem[]> {
  const rows = await many<DeliverableServer>(env, SERVER_SQL, user.id, isAdmin ? 1 : 0);
  const userTier = isAdmin ? "personal" : (user.tier ?? "free");

  return rows
    .filter((row) => isDeliverable(row, isAdmin))
    .filter((row) => row.enabled !== 0)
    .filter((row) => {
      const tier = row.tier ?? "free";
      if (tier === "personal") return isAdmin;
      if (userTier === "premium") return true;
      return tier === "free";
    })
    .filter(isModern)
    .sort(compareServers)
    .slice(0, limit)
    .map((row) => {
      const country = row.country_name ?? "";
      const ping = row.latency_ms ? `${row.latency_ms} мс` : "—";
      return {
        id: row.id,
        country: row.country_code ?? "",
        label: country ? `${country} · ${ping}` : `Сервер #${row.id} · ${ping}`,
        latency: row.latency_ms ?? null,
      };
    });
}
