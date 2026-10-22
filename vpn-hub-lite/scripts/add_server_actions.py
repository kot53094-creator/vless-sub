import pathlib

p = pathlib.Path("src/admin.ts")
s = p.read_text(encoding="utf-8")

anchor = '  if (action === "geo") {'
block = '''  if (action === "server_toggle") {
    const id = Number(form.get("id") ?? 0);
    await run(env, "UPDATE servers SET enabled = 1 - enabled WHERE id = ?", id);
    const row = await one<{ enabled: number }>(env, "SELECT enabled FROM servers WHERE id = ?", id);
    return back("/admin/servers", row?.enabled ? "Сервер включён" : "Сервер выключен");
  }

  if (action === "server_delete") {
    const id = Number(form.get("id") ?? 0);
    await run(env, "DELETE FROM assignments WHERE server_id = ?", id);
    await run(env, "DELETE FROM pool_servers WHERE server_id = ?", id);
    await run(env, "DELETE FROM server_checks WHERE server_id = ?", id);
    await run(env, "DELETE FROM servers WHERE id = ?", id);
    await logEvent(env, "server_delete", null, `id ${id}`);
    return back("/admin/servers", `Сервер #${id} удалён`);
  }

  if (action === "check_ids") {
    const ids = form
      .getAll("ids")
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .slice(0, 10);
    if (!ids.length) return back("/admin/servers", "", "Ничего не выбрано");
    const { checkServerIds } = await import("./health_manual");
    const result = await checkServerIds(env, ids);
    return back(
      "/admin/servers",
      `Проверено ${result.checked}, ответили ${result.alive}. Это TCP, туннель не проверялся.`,
    );
  }

  if (action === "bulk_servers") {
    const op = String(form.get("op") ?? "");
    const ids = [
      ...new Set(
        form
          .getAll("ids")
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    ].slice(0, 10);
    if (!ids.length) return back("/admin/servers", "", "Отметьте серверы галочками");
    const list = ids.map(() => "?").join(",");

    if (op === "check") {
      const { checkServerIds } = await import("./health_manual");
      const result = await checkServerIds(env, ids);
      return back(
        "/admin/servers",
        `Проверено ${result.checked}, ответили ${result.alive}. Это TCP, туннель не проверялся.`,
      );
    }
    if (op === "disable" || op === "enable") {
      await run(
        env,
        `UPDATE servers SET enabled = ? WHERE id IN (${list})`,
        op === "enable" ? 1 : 0,
        ...ids,
      );
      return back("/admin/servers", op === "enable" ? "Включены" : "Выключены");
    }
    if (op === "free" || op === "premium") {
      await run(env, `UPDATE servers SET tier = ? WHERE id IN (${list})`, op, ...ids);
      return back("/admin/servers", `Тариф ${op.toUpperCase()} назначен`);
    }
    if (op === "delete") {
      for (const table of ["assignments", "pool_servers", "server_checks"]) {
        await run(env, `DELETE FROM ${table} WHERE server_id IN (${list})`, ...ids);
      }
      await run(env, `DELETE FROM servers WHERE id IN (${list})`, ...ids);
      await logEvent(env, "server_bulk_delete", null, ids.join(","));
      return back("/admin/servers", `Удалено серверов: ${ids.length}`);
    }
    return back("/admin/servers", "", "Неизвестная операция");
  }

'''

s = s.replace(anchor, block + anchor, 1)
p.write_text(s, encoding="utf-8")
print("ok")
