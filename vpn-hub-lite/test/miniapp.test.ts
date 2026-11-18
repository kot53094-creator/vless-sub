import { describe, expect, it } from "vitest";
import { renderMiniApp } from "../src/miniapp";
import type { Env } from "../src/types";

const env = {
  PUBLIC_BASE_URL: "https://vpn-hub-lite.example.workers.dev",
  BOT_USERNAME: "apelsinka_vpn_bot",
} as unknown as Env;

async function page(): Promise<string> {
  const res = renderMiniApp(env);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  return await res.text();
}

/** Инлайн-скрипт страницы без внешнего <script src>. */
function inlineScript(html: string): string {
  const parts = html.split("<script>");
  expect(parts.length).toBeGreaterThan(1);
  return parts[1].split("</script>")[0];
}

describe("мини-апп", () => {
  it("собирается и содержит три экрана", async () => {
    const html = await page();
    expect(html).toContain('id="tab-home"');
    expect(html).toContain('id="tab-plans"');
    expect(html).toContain('id="tab-profile"');
  });

  it("инлайн-скрипт синтаксически корректен", async () => {
    const html = await page();
    // Пустой экран раньше получался из-за сломанной строки в onclick:
    // здесь проверяется, что весь скрипт вообще разбирается.
    expect(() => new Function(inlineScript(html))).not.toThrow();
  });

  it("в разметке нет строковых обработчиков с названием устройства", async () => {
    const html = await page();
    expect(html).not.toMatch(/onclick="[^"]*label/);
    expect(html).toContain('data-act="kick"');
  });

  it("подставляет имя бота в поддержку", async () => {
    const html = await page();
    expect(html).toContain("https://t.me/apelsinka_vpn_bot");
  });
});
