/**
 * Telegram Mini App — личный кабинет «Апельсинка VPN».
 *
 * Светлый кремовый интерфейс с оливково-лаймовым акцентом: три экрана
 * (Главная, Подписка, Профиль), тёмная карточка состояния подписки,
 * список сроков продления и список устройств с моделью и версией ОС.
 *
 * Вся работа с разметкой идёт через data-атрибуты и делегирование кликов:
 * строки вида onclick="fn('метка')" ломались на кавычках в названии
 * устройства и роняли весь инлайн-скрипт — экран оставался пустым.
 */

import type { Env } from "./types";
import { envStr } from "./security";

export function renderMiniApp(env: Env): Response {
  const baseUrl = (envStr(env.PUBLIC_BASE_URL) || "").replace(/\/$/, "");
  const botUsername = envStr(env.BOT_USERNAME) || "apelsinka_vpn_bot";

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Апельсинка VPN — личный кабинет</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #F4F3E7;
    --bg-soft: #EDECDC;
    --card: #FBFAF2;
    --card-pure: #FFFFFF;
    --dark: #1E2318;
    --dark-2: #262C1E;
    --line: #E2E0CC;
    --line-soft: #EEECDD;
    --ink: #14180C;
    --ink-2: #5B6050;
    --ink-3: #8B8F7C;
    --lime: #C6E58A;
    --lime-2: #AFD45F;
    --olive: #6E7A3C;
    --olive-2: #8A9A4A;
    --danger: #C2452F;
    --warn: #B4862A;
    --r-xl: 26px;
    --r-lg: 20px;
    --r-md: 14px;
    --r-sm: 10px;
    --shadow: 0 14px 28px -20px rgba(30, 35, 24, 0.55);
    --safe-b: env(safe-area-inset-bottom, 0px);
    --safe-t: env(safe-area-inset-top, 0px);
  }

  [data-theme="dark"] {
    --bg: #0D1117;
    --bg-soft: #161B22;
    --card: #161B22;
    --card-pure: #21262D;
    --dark: #090D12;
    --dark-2: #161B22;
    --line: #30363D;
    --line-soft: #21262D;
    --ink: #F0F6FC;
    --ink-2: #C9D1D9;
    --ink-3: #8B949E;
    --lime: #7EE787;
    --lime-2: #56D364;
    --olive: #2EA043;
    --olive-2: #3FB950;
    --danger: #F85149;
    --warn: #D29922;
    --shadow: 0 14px 28px -20px rgba(0, 0, 0, 0.85);
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
  }

  html, body { height: 100%; }

  body {
    font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--ink);
    background-color: var(--bg);
    background-image:
      linear-gradient(rgba(20, 24, 12, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(20, 24, 12, 0.05) 1px, transparent 1px);
    background-size: 94px 94px, 94px 94px;
    background-position: -1px -1px;
    min-height: 100vh;
    padding-top: var(--safe-t);
    overflow-x: hidden;
    -webkit-font-smoothing: antialiased;
  }

  button {
    font-family: inherit;
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .app {
    max-width: 560px;
    margin: 0 auto;
    padding: 0 16px calc(104px + var(--safe-b));
  }

  /* ── шапка ─────────────────────────────────────────────────────────── */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    margin: 0 -16px;
    background: var(--bg);
    opacity: 0.96;
    backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--line-soft);
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .brand-logo {
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: var(--dark);
    display: grid;
    place-items: center;
    font-size: 16px;
    line-height: 1;
    flex: none;
  }

  .brand-name {
    font-size: 14px;
    font-weight: 800;
    letter-spacing: -0.2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .avatar {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--card);
    display: grid;
    place-items: center;
    flex: none;
  }

  .avatar svg { width: 18px; height: 18px; stroke: var(--ink-2); }

  /* ── вкладки ───────────────────────────────────────────────────────── */
  .tab { display: none; }
  .tab.on { display: block; animation: rise 0.28s cubic-bezier(0.22, 1, 0.36, 1); }

  @keyframes rise {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .greet {
    padding: 18px 2px 14px;
    font-size: 15px;
    font-weight: 500;
    color: var(--ink-2);
    line-height: 1.35;
  }

  .greet b {
    display: block;
    font-size: 23px;
    font-weight: 800;
    letter-spacing: -0.6px;
    color: var(--ink);
    margin-top: 2px;
  }

  /* ── тёмная карточка подписки ──────────────────────────────────────── */
  .hero {
    background: var(--dark);
    border-radius: var(--r-xl);
    padding: 20px 18px 14px;
    color: #F3F4E7;
    box-shadow: 0 20px 40px -26px rgba(30, 35, 24, 0.9);
  }

  .hero-head {
    display: flex;
    align-items: center;
    gap: 14px;
  }

  .check {
    width: 54px;
    height: 54px;
    border-radius: 50%;
    background: var(--lime);
    display: grid;
    place-items: center;
    flex: none;
  }

  .check svg { width: 26px; height: 26px; stroke: #232A16; stroke-width: 2.6; }

  .hero-title {
    font-size: 21px;
    font-weight: 800;
    letter-spacing: -0.5px;
    line-height: 1.15;
  }

  .hero-sub {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--lime);
    margin-top: 4px;
  }

  .hero-sub.dead { color: #F09A82; }

  .hero-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    margin: 18px 0 16px;
    padding-top: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.13);
  }

  .hg { min-width: 0; }
  .hg + .hg { border-left: 1px solid rgba(255, 255, 255, 0.13); padding-left: 14px; }

  .hg-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 700;
    color: #AEB5A0;
    letter-spacing: 0.01em;
  }

  .hg-label svg { width: 14px; height: 14px; stroke: #AEB5A0; flex: none; }

  .hg-value {
    font-size: 14.5px;
    font-weight: 800;
    margin: 7px 0 8px;
    letter-spacing: -0.2px;
  }

  .bar {
    height: 5px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.16);
    overflow: hidden;
  }

  .bar i {
    display: block;
    height: 100%;
    width: 0;
    border-radius: 4px;
    background: var(--lime);
    transition: width 0.45s ease;
  }

  .bar i.warn { background: #E8B34B; }
  .bar i.dead { background: #E1684F; }
  .bar i.idle { background: repeating-linear-gradient(90deg, rgba(255,255,255,.32) 0 6px, transparent 6px 12px); }

  .hg-note {
    font-size: 11px;
    line-height: 1.35;
    color: #949B86;
    margin-top: 7px;
    font-weight: 500;
  }

  .btn-lime {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--lime);
    color: #232A16;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: -0.2px;
    padding: 15px 16px;
    border-radius: var(--r-md);
    transition: transform 0.14s ease, filter 0.14s ease;
  }

  .btn-lime:active { transform: scale(0.985); filter: brightness(0.95); }

  .hero-actions {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.13);
  }

  .hero-actions button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    padding: 12px 4px 6px;
    font-size: 12px;
    font-weight: 600;
    color: #DCE0CE;
  }

  .hero-actions button + button { border-left: 1px solid rgba(255, 255, 255, 0.13); }

  .hero-actions svg { width: 21px; height: 21px; stroke: #DCE0CE; stroke-width: 1.7; }

  .hero-foot {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    margin-top: 6px;
    padding: 13px 0 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.13);
    color: var(--lime);
    font-size: 13.5px;
    font-weight: 700;
  }

  .hero-foot svg { width: 14px; height: 14px; stroke: var(--lime); }

  /* ── светлые карточки ──────────────────────────────────────────────── */
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    padding: 16px;
    margin-top: 12px;
    box-shadow: var(--shadow);
  }

  .card.plain { box-shadow: none; }
  .card.pad0 { padding: 4px 6px; }

  .card-title {
    font-size: 14.5px;
    font-weight: 800;
    letter-spacing: -0.2px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 10px;
  }

  .card-title span.hint {
    font-size: 12px;
    font-weight: 600;
    color: var(--olive);
  }

  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 10px;
    text-align: left;
    border-radius: var(--r-md);
  }

  .row + .row { border-top: 1px solid var(--line-soft); }

  .row:active { background: rgba(110, 122, 60, 0.07); }

  .row-ico {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    background: var(--bg-soft);
    display: grid;
    place-items: center;
    font-size: 15px;
    flex: none;
  }

  .row-body { flex: 1; min-width: 0; }

  .row-title { font-size: 13.5px; font-weight: 700; }

  .row-sub { font-size: 11.5px; color: var(--ink-3); margin-top: 2px; font-weight: 500; }

  .row-chev svg { width: 16px; height: 16px; stroke: var(--ink-3); }

  /* ── предупреждение ────────────────────────────────────────────────── */
  .note {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    margin-top: 12px;
    padding: 12px 14px;
    border-radius: var(--r-md);
    background: #FBF2D9;
    border: 1px solid #EBDCA9;
    color: #6C5518;
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.4;
  }

  .note.bad { background: #FBE7E1; border-color: #EFC4B7; color: #7E2E1C; }

  /* ── страницы ──────────────────────────────────────────────────────── */
  .page-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 0 12px;
  }

  .back {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line);
    display: grid;
    place-items: center;
    flex: none;
  }

  .back svg { width: 17px; height: 17px; stroke: var(--ink); }

  .h1 {
    font-size: 27px;
    font-weight: 800;
    letter-spacing: -0.9px;
  }

  .h2 {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.5px;
    margin: 20px 2px 10px;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--olive-2);
    padding: 14px 2px 0;
  }

  .muted { font-size: 13px; color: var(--ink-3); font-weight: 500; }

  /* текущий тариф */
  .plan-cur {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-3);
    margin-bottom: 10px;
  }

  .plan-cur-row { display: flex; align-items: center; gap: 12px; }

  .plan-cur-ico {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    background: var(--bg-soft);
    display: grid;
    place-items: center;
    flex: none;
  }

  .plan-cur-ico svg { width: 20px; height: 20px; stroke: var(--olive); }

  .plan-cur-title { font-size: 15px; font-weight: 800; letter-spacing: -0.3px; line-height: 1.3; }

  .plan-cur-sub { font-size: 12.5px; color: var(--ink-3); font-weight: 500; margin-top: 3px; }

  /* сроки */
  .plans { display: flex; flex-direction: column; gap: 8px; }

  .plan-opt {
    display: grid;
    grid-template-columns: 20px 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 15px 16px;
    background: var(--card-pure);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    cursor: pointer;
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .plan-opt.sel {
    border-color: var(--olive-2);
    background: #F6F8EC;
    box-shadow: inset 0 0 0 1px var(--olive-2);
  }

  .radio {
    width: 19px;
    height: 19px;
    border-radius: 50%;
    border: 1.5px solid #C9C7B2;
    display: grid;
    place-items: center;
    flex: none;
  }

  .plan-opt.sel .radio { border-color: var(--olive-2); background: var(--olive-2); }
  .plan-opt.sel .radio::after {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #F6F8EC;
  }

  .po-name { font-size: 14.5px; font-weight: 700; letter-spacing: -0.2px; }

  .po-right { text-align: right; }

  .po-price { font-size: 15.5px; font-weight: 800; letter-spacing: -0.4px; white-space: nowrap; }

  .po-per { font-size: 11.5px; color: var(--ink-3); font-weight: 600; margin-top: 2px; }

  .po-badge {
    display: inline-block;
    margin-top: 4px;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--olive);
    background: #E9F0D3;
    border-radius: 6px;
    padding: 2px 7px;
  }

  .chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }

  .chip {
    padding: 9px 14px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card-pure);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-2);
  }

  .chip.on {
    border-color: var(--olive-2);
    background: #EDF3DC;
    color: var(--olive);
    font-weight: 700;
  }

  .btn-olive {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 14px;
    padding: 15px;
    border-radius: var(--r-md);
    background: var(--olive);
    color: #F6F8EC;
    font-size: 15px;
    font-weight: 800;
    letter-spacing: -0.2px;
    transition: transform 0.14s ease, filter 0.14s ease;
  }

  .btn-olive:active { transform: scale(0.985); filter: brightness(0.94); }
  .btn-olive[disabled] { opacity: 0.55; }

  .fine {
    font-size: 11px;
    color: var(--ink-3);
    text-align: center;
    line-height: 1.5;
    margin-top: 10px;
    font-weight: 500;
  }

  /* ── устройства ────────────────────────────────────────────────────── */
  .devices { margin-top: 6px; }

  .dev {
    display: flex;
    gap: 12px;
    padding: 16px 2px;
    border-bottom: 1px solid var(--line);
  }

  .dev:last-child { border-bottom: none; }

  .dev-num {
    font-size: 19px;
    font-weight: 800;
    color: var(--olive-2);
    letter-spacing: -0.5px;
    width: 30px;
    flex: none;
    line-height: 1.15;
    padding-top: 1px;
  }

  .dev-body { flex: 1; min-width: 0; }

  .dev-name {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: -0.3px;
    line-height: 1.3;
    word-break: break-word;
  }

  .dev-meta {
    font-size: 12px;
    color: var(--ink-3);
    font-weight: 500;
    margin-top: 3px;
    line-height: 1.4;
  }

  .dev-meta b { color: var(--olive); font-weight: 700; }
  .dev-meta.off { color: var(--danger); font-weight: 600; }

  .dev-out {
    margin-top: 10px;
    padding: 9px 18px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card-pure);
    font-size: 12px;
    font-weight: 700;
    color: var(--ink-2);
  }

  .dev-out:active { background: var(--bg-soft); }

  .dev-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }

  .dev-actions .dev-out { margin-top: 0; }

  .dev-edit {
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: transparent;
    font-size: 12px;
    font-weight: 700;
    color: var(--olive);
  }

  .dev-edit:active { background: var(--bg-soft); }

  .dev-hint {
    font-size: 11.5px;
    color: var(--ink-3);
    line-height: 1.45;
    margin-top: 12px;
    font-weight: 500;
  }

  .empty {
    padding: 18px 4px;
    font-size: 13px;
    color: var(--ink-3);
    line-height: 1.5;
    font-weight: 500;
  }

  /* ── прочее ────────────────────────────────────────────────────────── */
  .input-row { display: flex; gap: 8px; }

  .input {
    flex: 1;
    min-width: 0;
    background: var(--card-pure);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: 13px 14px;
    font-size: 14px;
    font-family: inherit;
    color: var(--ink);
    outline: none;
  }

  .input:focus { border-color: var(--olive-2); }

  .mini-btn {
    padding: 0 16px;
    border-radius: var(--r-md);
    background: var(--olive);
    color: #F6F8EC;
    font-size: 13px;
    font-weight: 700;
    white-space: nowrap;
  }

  .stat-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

  .stat {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: 14px;
    text-align: center;
  }

  .stat b { display: block; font-size: 22px; font-weight: 800; letter-spacing: -0.7px; color: var(--olive); }

  .stat span { font-size: 11.5px; color: var(--ink-3); font-weight: 600; }

  .list-line {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 0;
    font-size: 12.5px;
    border-bottom: 1px solid var(--line-soft);
    color: var(--ink-2);
    font-weight: 500;
  }

  .list-line:last-child { border-bottom: none; }

  .list-line b { font-weight: 700; color: var(--ink); }

  .list-line .ok { color: var(--olive); font-weight: 700; }
  .list-line .wait { color: var(--warn); font-weight: 700; }

  .faq-item { border-bottom: 1px solid var(--line-soft); }
  .faq-item:last-child { border-bottom: none; }

  .faq-q {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 13px 0;
    font-size: 13.5px;
    font-weight: 700;
    line-height: 1.35;
  }

  .faq-q svg { width: 15px; height: 15px; stroke: var(--ink-3); flex: none; transition: transform 0.2s ease; }

  .faq-item.open .faq-q svg { transform: rotate(180deg); }

  .faq-a {
    display: none;
    font-size: 12.5px;
    color: var(--ink-2);
    line-height: 1.55;
    padding-bottom: 13px;
    white-space: pre-line;
    font-weight: 500;
  }

  .faq-item.open .faq-a { display: block; }

  /* ── нижняя навигация ──────────────────────────────────────────────── */
  .nav {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    padding-bottom: var(--safe-b);
    background: var(--bg);
    opacity: 0.98;
    border-top: 1px solid var(--line);
    backdrop-filter: blur(16px);
  }

  .nav-inner {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    width: 100%;
    max-width: 560px;
    padding: 8px 8px 10px;
  }

  .nav-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 6px 0;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-3);
    border-radius: var(--r-md);
  }

  .nav-btn svg { width: 22px; height: 22px; stroke: currentColor; stroke-width: 1.8; }

  .nav-btn.on { color: var(--lime); font-weight: 800; background: var(--bg-soft); }

  /* ── модальное окно ────────────────────────────────────────────────── */
  .sheet {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: none;
    align-items: flex-end;
    background: rgba(20, 24, 12, 0.45);
    backdrop-filter: blur(3px);
  }

  .sheet.on { display: flex; }

  .sheet-inner {
    width: 100%;
    max-width: 560px;
    margin: 0 auto;
    background: var(--card-pure);
    border-radius: 24px 24px 0 0;
    padding: 22px 20px calc(24px + var(--safe-b));
  }

  .sheet-title {
    font-size: 18px;
    font-weight: 800;
    letter-spacing: -0.4px;
    margin-bottom: 12px;
  }

  .qr-box { display: grid; place-items: center; padding: 10px 0 16px; }

  .qr-box img {
    width: 220px;
    height: 220px;
    border-radius: var(--r-md);
    background: #fff;
  }

  .steps { font-size: 12.5px; color: var(--ink-2); line-height: 1.6; font-weight: 500; }

  .steps b { color: var(--ink); }

  .steps li { margin-left: 18px; margin-bottom: 7px; }

  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(96px + var(--safe-b));
    transform: translateX(-50%) translateY(24px);
    max-width: calc(100vw - 32px);
    padding: 12px 18px;
    border-radius: 14px;
    background: var(--dark);
    color: #F3F4E7;
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.22s ease, transform 0.22s ease;
    z-index: 100;
  }

  .toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>

<div class="app">
  <div class="topbar">
    <div class="brand">
      <div class="brand-logo">🍊</div>
      <div class="brand-name">Апельсинка VPN</div>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <button class="avatar" data-act="toggle-theme" id="theme-btn" aria-label="Сменить тему" title="Сменить тему">
        <span id="theme-icon" style="font-size:15px; line-height:1;">🌙</span>
      </button>
      <button class="avatar" data-act="tab" data-tab="profile" aria-label="Профиль">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round">
          <circle cx="12" cy="8" r="3.6"></circle>
          <path d="M4.5 20c0-3.6 3.4-5.6 7.5-5.6s7.5 2 7.5 5.6"></path>
        </svg>
      </button>
    </div>
  </div>

  <!-- ── Главная ─────────────────────────────────────────────────────── -->
  <section id="tab-home" class="tab on">
    <div class="greet">
      <span id="greet-word">Добрый день,</span>
      <b id="greet-name">—</b>
    </div>

    <div class="hero">
      <div class="hero-head">
        <div class="check" id="hero-check">
          <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4.5 12.5 9.5 17.5 19.5 6.5"></path>
          </svg>
        </div>
        <div>
          <div class="hero-title" id="hero-title">Подписка активна</div>
          <div class="hero-sub" id="hero-sub">загрузка…</div>
        </div>
      </div>

      <div class="hero-grid">
        <div class="hg">
          <div class="hg-label">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round">
              <rect x="2.5" y="4.5" width="19" height="12" rx="2.5"></rect>
              <path d="M8 20h8"></path>
            </svg>
            Устройства
          </div>
          <div class="hg-value" id="dev-free">— свободно</div>
          <div class="bar"><i id="dev-bar"></i></div>
          <div class="hg-note" id="dev-note">—</div>
        </div>
        <div class="hg">
          <div class="hg-label">
            <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 15l4.5-5 4 3.5L21 4"></path>
              <path d="M3 20h18"></path>
            </svg>
            Общий трафик
          </div>
          <div class="hg-value" id="traffic-free">— ГБ свободно</div>
          <div class="bar"><i id="traffic-bar"></i></div>
          <div class="hg-note" id="traffic-note">—</div>
        </div>
      </div>

      <button class="btn-lime" data-act="connect">+ Подключить устройство</button>

      <div class="hero-actions">
        <button data-act="qr">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round">
            <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
            <rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
            <rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
            <path d="M14 14h3v3h-3z"></path>
            <path d="M20 14v3M14 20h3M20 20h1"></path>
          </svg>
          QR
        </button>
        <button data-act="copy">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round">
            <rect x="9" y="9" width="11" height="11" rx="2.5"></rect>
            <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"></path>
          </svg>
          Скопировать
        </button>
        <button data-act="guide">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round">
            <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4.5A1.5 1.5 0 0 1 3 16.5z"></path>
            <path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5.5A1.5 1.5 0 0 0 21 16.5z"></path>
          </svg>
          Инструкция
        </button>
      </div>

      <button class="hero-foot" data-act="tab" data-tab="plans">
        Продлить подписку
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 5 16 12 9 19"></polyline>
        </svg>
      </button>
    </div>

    <div id="alerts"></div>

    <div class="card pad0" style="margin-top:14px">
      <button class="row" data-act="tab" data-tab="plans">
        <span class="row-ico">💳</span>
        <span class="row-body">
          <span class="row-title">Продлить тариф</span>
          <span class="row-sub" id="row-plan-sub">Выбор срока и оплата</span>
        </span>
        <span class="row-chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="9 5 16 12 9 19"></polyline></svg></span>
      </button>
      <button class="row" data-act="pick-promo">
        <span class="row-ico">🎟</span>
        <span class="row-body">
          <span class="row-title">Промокод</span>
          <span class="row-sub">Активировать код и продлить дни</span>
        </span>
        <span class="row-chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="9 5 16 12 9 19"></polyline></svg></span>
      </button>
      <button class="row" data-act="tab" data-tab="profile">
        <span class="row-ico">📱</span>
        <span class="row-body">
          <span class="row-title">Устройства</span>
          <span class="row-sub" id="row-dev-sub">Управление слотами</span>
        </span>
        <span class="row-chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="9 5 16 12 9 19"></polyline></svg></span>
      </button>
      <button class="row" data-act="support">
        <span class="row-ico">💬</span>
        <span class="row-body">
          <span class="row-title">Поддержка</span>
          <span class="row-sub">Поможем с настройкой</span>
        </span>
        <span class="row-chev"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="9 5 16 12 9 19"></polyline></svg></span>
      </button>
    </div>

    <div class="card" id="packs-card" hidden>
      <div class="card-title">
        Докупить трафик
        <span class="hint" id="packs-hint"></span>
      </div>
      <div class="chips" id="packs-row"></div>
    </div>
  </section>

  <!-- ── Подписка ────────────────────────────────────────────────────── -->
  <section id="tab-plans" class="tab">
    <div class="page-head">
      <button class="back" data-act="tab" data-tab="home" aria-label="Назад">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="11 5 4 12 11 19"></polyline>
        </svg>
      </button>
      <h1 class="h1">Подписка</h1>
    </div>

    <div class="card plain">
      <div class="plan-cur">Текущий тариф</div>
      <div class="plan-cur-row">
        <div class="plan-cur-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round">
            <rect x="2.5" y="4.5" width="19" height="12" rx="2.5"></rect>
            <path d="M8 20h8"></path>
          </svg>
        </div>
        <div style="min-width:0">
          <div class="plan-cur-title" id="cur-title">—</div>
          <div class="plan-cur-sub" id="cur-sub">—</div>
        </div>
      </div>
    </div>

    <h2 class="h2">Выберите срок</h2>
    <div class="plans" id="plans-list">
      <div class="empty">Загрузка тарифов…</div>
    </div>

    <div class="chips" id="providers"></div>

    <button class="btn-olive" data-act="pay" id="pay-btn">Оплатить</button>
    <p class="fine">Оплата разовая. Автопродления и скрытых списаний нет.</p>
  </section>

  <!-- ── Профиль ─────────────────────────────────────────────────────── -->
  <section id="tab-profile" class="tab">
    <div class="page-head" style="padding-bottom:4px">
      <h1 class="h1">Профиль</h1>
    </div>

    <div class="eyebrow">подключения</div>
    <h2 class="h2" style="margin-top:4px">Ваши устройства</h2>
    <div class="muted" id="dev-count">загрузка…</div>

    <button class="btn-olive" data-act="connect">+ Подключить устройство</button>
    <div id="name-hint"></div>
    <div class="devices" id="device-list">
      <div class="empty">Загрузка устройств…</div>
    </div>
    <div class="dev-hint">
      Клиенты (Happ, INCY, v2rayNG) обычно не присылают модель телефона — только
      платформу. Нажмите «Назвать», чтобы подписать устройство по-своему.
    </div>

    <div class="card">
      <div class="card-title">
        Бонус дня
        <span class="hint" id="bonus-hint">+ часы к подписке</span>
      </div>
      <p class="muted" style="margin-bottom:10px">
        Каждый день можно забрать несколько часов доступа бесплатно — просто откройте кабинет.
      </p>
      <button class="btn-olive" style="margin-top:0" data-act="bonus">Забрать бонус дня</button>
    </div>

    <h2 class="h2">Партнёрская программа</h2>
    <div class="card plain" style="margin-top:0">
      <p class="muted" style="margin-bottom:12px">
        Приглашайте друзей и получайте <b style="color:var(--ink)">+3 дня</b> за каждого, кто подключится.
      </p>
      <div class="input-row">
        <input class="input" id="ref-link" readonly value="загрузка…">
        <button class="mini-btn" data-act="copy-ref">Копировать</button>
      </div>
      <button class="btn-olive" data-act="share-ref">Поделиться в Telegram</button>
      <div class="stat-2" style="margin-top:12px">
        <div class="stat"><b id="ref-invited">0</b><span>приглашено</span></div>
        <div class="stat"><b id="ref-days">+0</b><span>дней получено</span></div>
      </div>
    </div>

    <h2 class="h2">Промокод</h2>
    <div class="card plain" style="margin-top:0" id="promo-card">
      <div class="input-row">
        <input class="input" id="promo-input" placeholder="Введите код" autocomplete="off">
        <button class="mini-btn" data-act="promo">Применить</button>
      </div>
    </div>

    <h2 class="h2">Покупки</h2>
    <div class="card plain" style="margin-top:0">
      <div id="orders-list"><div class="empty">Загрузка…</div></div>
    </div>

    <h2 class="h2">Помощь</h2>
    <div class="card plain" style="margin-top:0">
      <div id="faq-list"><div class="empty">Загрузка…</div></div>
      <button class="btn-olive" data-act="support">Написать в поддержку</button>
      <a href="/admin" target="_blank" class="btn-olive" style="background:var(--bg-soft); color:var(--ink); margin-top:10px; text-decoration:none;">
        ⚙️ Панель администратора
      </a>
    </div>
  </section>
</div>

<nav class="nav">
  <div class="nav-inner">
    <button class="nav-btn" data-act="tab" data-tab="plans">
      <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l7.5 3v5.6c0 4.4-3.1 8.1-7.5 9.4-4.4-1.3-7.5-5-7.5-9.4V6z"></path>
        <polyline points="8.8 12.2 11.2 14.6 15.4 10.2"></polyline>
      </svg>
      Подписка
    </button>
    <button class="nav-btn on" data-act="tab" data-tab="home">
      <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15V14H9v6.5H5.5A1.5 1.5 0 0 1 4 19z"></path>
      </svg>
      Главная
    </button>
    <button class="nav-btn" data-act="tab" data-tab="profile">
      <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round">
        <circle cx="12" cy="12" r="9"></circle>
        <circle cx="12" cy="10" r="3"></circle>
        <path d="M6.5 18.4c1-2.4 3-3.6 5.5-3.6s4.5 1.2 5.5 3.6"></path>
      </svg>
      Профиль
    </button>
  </div>
</nav>

<div class="sheet" id="sheet">
  <div class="sheet-inner" id="sheet-inner"></div>
</div>

<div class="toast" id="toast"></div>

<script>
  var tg = (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
    } catch (e) {}
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var ico = $('theme-icon');
    if (ico) ico.textContent = theme === 'dark' ? '☀️' : '🌙';
    try {
      localStorage.setItem('vh_theme', theme);
      if (tg) {
        var bg = theme === 'dark' ? '#0D1117' : '#F4F3E7';
        tg.setHeaderColor(bg);
        tg.setBackgroundColor(bg);
      }
    } catch(e) {}
  }

  function toggleTheme() {
    haptic();
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  }

  // Автоопределение темы (localStorage -> Telegram colorScheme -> system)
  try {
    var saved = localStorage.getItem('vh_theme');
    if (saved) {
      applyTheme(saved);
    } else if (tg && tg.colorScheme === 'dark') {
      applyTheme('dark');
    }
  } catch(e) {}

  var state = {
    me: null,
    sub: null,
    traffic: null,
    metering: { available: false },
    devices: null,
    plans: [],
    selected: null,
    providers: [],
    provider: null,
    packs: [],
    faq: []
  };

  function $(id) { return document.getElementById(id); }

  function haptic(kind) {
    try { tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {}
  }

  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toDate(value) {
    if (!value) return null;
    var raw = String(value).replace(' ', 'T');
    if (!/Z$|[+-]\\d\\d:?\\d\\d$/.test(raw)) raw = raw + 'Z';
    var d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDay(value) {
    var d = toDate(value);
    if (!d) return '';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function fmtLong(value) {
    var d = toDate(value);
    if (!d) return '';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) + ' г.';
  }

  function fmtAgo(value) {
    var d = toDate(value);
    if (!d) return 'давно';
    var min = (Date.now() - d.getTime()) / 60000;
    if (min < 5) return 'активно сейчас';
    if (min < 60) return Math.round(min) + ' мин назад';
    if (min < 1440) return Math.round(min / 60) + ' ч назад';
    return 'активно ' + fmtDay(value);
  }

  function num(value, digits) {
    var n = Number(value || 0);
    return n.toFixed(digits == null ? 1 : digits).replace('.', ',');
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  function api(path, options) {
    options = options || {};
    var headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
    if (tg && tg.initData) headers['x-telegram-init-data'] = tg.initData;
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (r) {
      return r.json();
    });
  }

  // ── навигация ────────────────────────────────────────────────────────
  function switchTab(name) {
    haptic();
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('on');
    var target = $('tab-' + name);
    if (target) target.classList.add('on');

    var navs = document.querySelectorAll('.nav-btn');
    for (var j = 0; j < navs.length; j++) {
      navs[j].classList.toggle('on', navs[j].getAttribute('data-tab') === name);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── главный экран ────────────────────────────────────────────────────
  function renderHero() {
    var sub = state.sub;
    var traffic = state.traffic;
    var devices = state.devices;
    if (!sub) return;

    var active = Boolean(sub.active);
    $('hero-title').textContent = active ? 'Подписка активна' : 'Подписка не активна';
    $('hero-check').style.background = active ? 'var(--lime)' : '#E7A491';

    var subEl = $('hero-sub');
    subEl.classList.toggle('dead', !active);
    if (active) {
      var days = Number(sub.days_left || 0);
      subEl.textContent = 'до ' + fmtLong(sub.expires_at) + ' · ' + days + ' ' + plural(days, 'день', 'дня', 'дней');
    } else if (sub.expires_at) {
      subEl.textContent = 'истекла ' + fmtLong(sub.expires_at);
    } else {
      subEl.textContent = 'выберите тариф слева';
    }

    // устройства
    var used = devices ? Number(devices.count || 0) : 0;
    var limit = devices ? Number(devices.limit || 0) : 0;
    var free = Math.max(0, limit - used);
    $('dev-free').textContent = free + ' ' + plural(free, 'свободен', 'свободно', 'свободно');
    var devBar = $('dev-bar');
    devBar.style.width = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) + '%' : '0%';
    devBar.className = free === 0 ? 'warn' : '';
    $('dev-note').textContent = used + ' занято из ' + limit + ' ' + plural(limit, 'слота', 'слотов', 'слотов');
    $('row-dev-sub').textContent = used + ' из ' + limit + ' · управление';

    // трафик
    var tBar = $('traffic-bar');
    var metering = state.metering || { available: false };
    if (!traffic || traffic.unlimited) {
      $('traffic-free').textContent = 'Безлимит';
      tBar.style.width = '100%';
      tBar.className = '';
      $('traffic-note').textContent = 'Ограничений по объёму нет';
    } else if (!metering.available) {
      // Квота есть, но ни один узел ещё не присылал расход: честно говорим,
      // что счётчик не крутится, вместо «10 ГБ свободно» с вечным нулём.
      $('traffic-free').textContent = traffic.limit_gb + ' ГБ по тарифу';
      tBar.style.width = '100%';
      tBar.className = 'idle';
      $('traffic-note').textContent = 'Учёт расхода не подключён — счётчик пока не уменьшается';
    } else {
      var leftGb = Math.max(0, Number(traffic.limit_gb || 0) - Number(traffic.used_gb || 0));
      $('traffic-free').textContent = num(leftGb) + ' ГБ свободно';
      var pct = Math.max(3, Math.min(100, Number(traffic.percent || 0)));
      tBar.style.width = pct + '%';
      tBar.className = traffic.exhausted ? 'dead' : (pct >= 90 ? 'warn' : '');
      $('traffic-note').textContent = traffic.measured
        ? num(traffic.used_gb) + ' ГБ использовано · ' + traffic.limit_gb + ' ГБ на все серверы'
        : 'Учёт включится после первого подключения';
    }

    renderAlerts();
  }

  function renderAlerts() {
    var box = $('alerts');
    var sub = state.sub || {};
    var traffic = state.traffic || {};
    var items = [];

    if (!sub.active) {
      items.push({ bad: true, text: 'Доступ приостановлен. Продлите тариф — ссылка подписки останется прежней.' });
    } else if (Number(sub.days_left || 0) <= 3) {
      items.push({ bad: false, text: 'Осталось ' + sub.days_left + ' ' + plural(Number(sub.days_left), 'день', 'дня', 'дней') + '. Продлите заранее, чтобы VPN не отключился.' });
    }

    var metering = state.metering || { available: false };
    if (!traffic.unlimited && traffic.limit_gb && !metering.available) {
      items.push({
        bad: false,
        text: 'Расход трафика пока не измеряется: у сервиса нет своего узла, статистику присылать некому. Квота ' +
          traffic.limit_gb + ' ГБ начнёт расходоваться, когда учёт включат.',
      });
    }

    if (traffic.exhausted) {
      items.push({ bad: true, text: 'Трафик ' + traffic.limit_gb + ' ГБ израсходован. Докупите пакет или смените тариф.' });
    } else if (metering.available && !traffic.unlimited && Number(traffic.percent || 0) >= 90) {
      items.push({ bad: false, text: 'Осталось мало трафика: ' + num(Number(traffic.limit_gb || 0) - Number(traffic.used_gb || 0)) + ' ГБ.' });
    }

    box.innerHTML = items.map(function (item) {
      return '<div class="note' + (item.bad ? ' bad' : '') + '"><span>' + (item.bad ? '⛔' : '⏳') + '</span><span>' + escHtml(item.text) + '</span></div>';
    }).join('');
  }

  // ── устройства ───────────────────────────────────────────────────────
  function splitLabel(label) {
    var parts = String(label || 'Устройство').split(' · ');
    var name = parts.shift() || 'Устройство';
    return { name: name, platform: parts.join(' · ') };
  }

  function renderDevices(dev) {
    var box = $('device-list');
    var count = $('dev-count');
    var list = (dev && dev.list) || [];
    var busy = list.filter(function (d) { return !d.blocked; }).length;

    if (count) {
      count.textContent = busy + ' ' + plural(busy, 'подключено', 'подключено', 'подключено') +
        (dev && dev.limit ? ' · лимит ' + dev.limit : '');
    }

    if (!list.length) {
      box.innerHTML = '<div class="empty">Пока ни одно устройство не открывало подписку. ' +
        'Импортируйте ссылку в приложение — устройство появится здесь автоматически.</div>';
      $('name-hint').innerHTML = '';
      return;
    }

    // Подсказка: мини-приложение знает модель телефона из своего WebView-UA,
    // а клиент подписки её не присылает. Предлагаем подписать свежее устройство.
    var guess = guessModel();
    var unnamed = list.filter(function (d) { return !String(d.name || '').trim(); });
    var hintBox = $('name-hint');
    if (guess && unnamed.length && guess !== splitLabel(unnamed[0].label).name) {
      hintBox.innerHTML = '<div class="note" style="align-items:center; justify-content:space-between; gap:10px">' +
        '<span>Похоже, это устройство — <b>' + escHtml(guess) + '</b></span>' +
        '<button class="dev-edit" style="flex:none" data-act="rename-guess" data-id="' + unnamed[0].id + '" data-name="' + escHtml(guess) + '">Назвать</button>' +
      '</div>';
    } else {
      hintBox.innerHTML = '';
    }

    box.innerHTML = list.map(function (d, index) {
      var parts = splitLabel(d.label);
      var custom = String(d.name || '').trim();
      var number = String(index + 1);
      if (number.length < 2) number = '0' + number;

      var stateText;
      if (d.blocked) {
        stateText = d.reason === 'limit' ? 'Заблокировано: лимит слотов' : 'Отключено';
      } else {
        stateText = 'Активно ' + fmtDay(d.last_seen);
      }

      // Имя, заданное человеком, важнее автоматического разбора UA.
      var title = custom || parts.name;
      var metaParts = [];
      if (custom) metaParts.push(d.label);
      else if (parts.platform) metaParts.push(parts.platform);
      metaParts.push(stateText);

      return '<div class="dev">' +
        '<div class="dev-num">' + number + '</div>' +
        '<div class="dev-body">' +
          '<div class="dev-name">' + escHtml(title) + '</div>' +
          '<div class="dev-meta' + (d.blocked ? ' off' : '') + '">' +
            escHtml(metaParts.join(' · ')) +
          '</div>' +
          '<div class="dev-actions">' +
            '<button class="dev-edit" data-act="rename" data-id="' + d.id + '" data-name="' + escHtml(custom || parts.name) + '">Назвать</button>' +
            '<button class="dev-out" data-act="kick" data-id="' + d.id + '" data-label="' + escHtml(custom || d.label) + '">' +
              (d.blocked ? 'Удалить' : 'Отключить') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Модель текущего телефона из UA мини-приложения: Telegram на Android
  // подставляет «Linux; Android 13; SM-A336E», iOS — «iPhone».
  function guessModel() {
    var ua = String(navigator.userAgent || '');
    var sm = /;\\s*(SM-[A-Z0-9]+)\\b/i.exec(ua);
    if (sm) return 'Samsung ' + sm[1].toUpperCase();
    var pixel = /(Pixel[ A-Za-z0-9]+?)(?: Build|\\)|;)/i.exec(ua);
    if (pixel) return 'Google ' + pixel[1].trim();
    var rn = /(Redmi[ A-Za-z0-9+]+|POCO[ A-Za-z0-9+]+|Xiaomi[ A-Za-z0-9+]+?)(?: Build|\\)|;)/i.exec(ua);
    if (rn) return rn[1].trim();
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Windows NT/i.test(ua)) return 'Windows PC';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'Mac';
    if (/Android/i.test(ua)) return 'Android';
    return '';
  }

  function renameSheet(id, current) {
    var guess = guessModel();
    var chips = guess && guess !== current
      ? '<div class="chips" style="margin-top:10px">' +
          '<button class="chip" data-act="rename-fill" data-name="' + escHtml(guess) + '">' + escHtml(guess) + ' (этот телефон)</button>' +
        '</div>'
      : '';

    openSheet(
      '<div class="sheet-title">Название устройства</div>' +
      '<p class="steps" style="margin-bottom:12px">Так устройство будет называться в этом списке: «Samsung A25», «Ноутбук», «Телефон мамы». Модель сама по себе клиенты почти никогда не присылают.</p>' +
      '<input class="input" id="rename-input" maxlength="40" placeholder="Например, Samsung A25" value="' + escHtml(current || '') + '">' +
      chips +
      '<button class="btn-olive" data-act="rename-save" data-id="' + id + '">Сохранить</button>' +
      '<button class="btn-olive" style="background:var(--bg-soft); color:var(--ink)" data-act="rename-clear" data-id="' + id + '">Сбросить название</button>'
    );

    setTimeout(function () {
      var input = $('rename-input');
      if (input) { input.focus(); }
    }, 260);
  }

  function saveDeviceName(id, name) {
    api('/api/app/devices/rename', {
      method: 'POST',
      body: JSON.stringify({ device_id: id, name: name })
    }).then(function (res) {
      if (res.ok) {
        closeSheet();
        toast(name ? 'Название сохранено' : 'Название сброшено');
        loadMe();
      } else {
        toast(res.error || 'Не удалось сохранить');
      }
    }).catch(function () { toast('Ошибка сети'); });
  }

  function kickDevice(id, label) {
    var run = function () {
      api('/api/app/devices/delete', { method: 'POST', body: JSON.stringify({ device_id: id }) })
        .then(function (res) {
          if (res.ok) {
            toast('Устройство отвязано');
            loadMe();
          } else {
            toast(res.error || 'Не удалось отвязать');
          }
        })
        .catch(function () { toast('Ошибка сети'); });
    };

    var question = 'Отвязать «' + label + '»? Устройство потеряет доступ, слот освободится.';
    if (tg && tg.showConfirm) {
      tg.showConfirm(question, function (ok) { if (ok) run(); });
    } else if (window.confirm(question)) {
      run();
    }
  }

  // ── тарифы ───────────────────────────────────────────────────────────
  function renderPlans() {
    var box = $('plans-list');
    if (!state.plans.length) {
      box.innerHTML = '<div class="empty">Тарифы ещё не настроены. Напишите в поддержку — подключим оплату.</div>';
      $('pay-btn').disabled = true;
      return;
    }

    box.innerHTML = state.plans.map(function (p) {
      var perMonth = p.days > 0 ? Math.round(p.price_rub / (p.days / 30)) : p.price_rub;
      var badge = p.badge || (p.featured ? 'Популярный' : '');
      return '<div class="plan-opt' + (p.code === state.selected ? ' sel' : '') + '" data-act="select" data-code="' + escHtml(p.code) + '">' +
        '<span class="radio"></span>' +
        '<span class="po-name">' + escHtml(p.title) + '</span>' +
        '<span class="po-right">' +
          '<span class="po-price">' + escHtml(p.price_label) + '</span>' +
          '<span class="po-per">' + perMonth + ' ₽/мес</span>' +
          (badge ? '<span class="po-badge">' + escHtml(badge) + '</span>' : '') +
        '</span>' +
      '</div>';
    }).join('');

    // Способы оплаты могли отключить (например, убрали Stars): тогда кнопка
    // не должна обещать оплату, которой нет.
    var chosen = state.plans.filter(function (p) { return p.code === state.selected; })[0] || state.plans[0];
    if (!state.provider) {
      $('pay-btn').disabled = true;
      $('pay-btn').textContent = 'Оплата временно недоступна';
      return;
    }
    $('pay-btn').disabled = false;
    if (chosen) $('pay-btn').textContent = 'Оплатить ' + chosen.price_label;
  }

  function renderProviders() {
    var box = $('providers');
    if (!state.providers.length) {
      box.innerHTML =
        '<div class="note">Приём оплаты сейчас недоступен: способы оплаты настраиваются. ' +
        'Напишите в поддержку — оформим вручную.</div>';
      return;
    }
    box.innerHTML = state.providers.map(function (p) {
      return '<button class="chip' + (p.id === state.provider ? ' on' : '') + '" data-act="provider" data-id="' + escHtml(p.id) + '">' +
        escHtml(p.label) + '</button>';
    }).join('');
  }

  function renderCurrentPlan() {
    if (!state.sub) return;
    var tier = String(state.sub.tier || 'БАЗОВЫЙ');
    var pieces = [tier];
    if (state.sub.days_left) pieces.push(state.sub.days_left + ' ' + plural(Number(state.sub.days_left), 'день', 'дня', 'дней'));
    if (state.traffic && !state.traffic.unlimited) pieces.push(state.traffic.limit_gb + ' ГБ на все серверы');

    $('cur-title').textContent = pieces.join(' · ');
    $('cur-sub').textContent = 'Общий лимит · ' + ((state.devices && state.devices.limit) || 0) + ' ' +
      plural(Number((state.devices && state.devices.limit) || 0), 'устройство', 'устройства', 'устройств');
    $('row-plan-sub').textContent = state.sub.active
      ? 'Действует до ' + fmtLong(state.sub.expires_at)
      : 'Подписка не активна';
  }

  function pay() {
    haptic('medium');
    var plan = state.plans.filter(function (p) { return p.code === state.selected; })[0] || state.plans[0];
    if (!plan) return toast('Нет доступных тарифов');
    if (!state.provider) return toast('Оплата ещё не подключена');

    var btn = $('pay-btn');
    btn.disabled = true;
    api('/api/app/buy', {
      method: 'POST',
      body: JSON.stringify({ plan_code: plan.code, provider: state.provider })
    }).then(function (res) {
      btn.disabled = false;
      if (!res.ok || !res.link) return toast(res.error || 'Не удалось создать счёт');

      if (res.open_invoice && tg && tg.openInvoice) {
        tg.openInvoice(res.link, function (status) {
          if (status === 'paid') { toast('Оплачено! Продлеваю подписку…'); loadMe(); loadOrders(); }
          else if (status === 'failed') toast('Оплата не прошла');
          else if (status === 'cancelled') toast('Оплата отменена');
        });
      } else if (tg && tg.openLink) {
        tg.openLink(res.link);
        toast('Открыл страницу оплаты');
      } else {
        window.open(res.link, '_blank');
      }
    }).catch(function () {
      btn.disabled = false;
      toast('Ошибка сети');
    });
  }

  // ── трафик: докупка ──────────────────────────────────────────────────
  function loadPacks() {
    // Без учёта расхода докупка гигабайт — продажа воздуха: проверить,
    // израсходован пакет или нет, физически нечем.
    if (!(state.metering && state.metering.available)) {
      $('packs-card').hidden = true;
      return;
    }
    api('/api/app/traffic-packs').then(function (res) {
      var card = $('packs-card');
      if (!res.ok || res.unlimited || !res.packs || !res.packs.length) {
        card.hidden = true;
        return;
      }
      state.packs = res.packs;
      card.hidden = false;
      $('packs-hint').textContent = 'лимит ' + (state.traffic && state.traffic.limit_gb ? state.traffic.limit_gb + ' ГБ' : '');
      $('packs-row').innerHTML = res.packs.map(function (p) {
        return '<button class="chip" data-act="pack" data-code="' + escHtml(p.code) + '">' +
          escHtml(p.title) + ' · ' + escHtml(p.price_label) + '</button>';
      }).join('');
    }).catch(function () { $('packs-card').hidden = true; });
  }

  function buyPack(code) {
    haptic();
    api('/api/app/topup', {
      method: 'POST',
      body: JSON.stringify({ code: code, provider: state.provider || undefined })
    }).then(function (res) {
      if (!res.ok || !res.link) return toast(res.error || 'Не удалось создать счёт');
      if (res.open_invoice && tg && tg.openInvoice) {
        tg.openInvoice(res.link, function (status) {
          if (status === 'paid') { toast('Трафик зачислен'); loadMe(); }
        });
      } else if (tg && tg.openLink) {
        tg.openLink(res.link);
      } else {
        window.open(res.link, '_blank');
      }
    }).catch(function () { toast('Ошибка сети'); });
  }

  // ── история, FAQ ─────────────────────────────────────────────────────
  function loadOrders() {
    api('/api/app/orders').then(function (res) {
      var box = $('orders-list');
      if (!res.ok || !res.orders || !res.orders.length) {
        box.innerHTML = '<div class="empty">Покупок пока нет.</div>';
        return;
      }
      var status = { paid: 'оплачен', pending: 'ждёт оплаты', refunded: 'возврат', expired: 'истёк', canceled: 'отменён', failed: 'ошибка' };
      box.innerHTML = res.orders.map(function (o) {
        var done = o.status === 'paid';
        return '<div class="list-line">' +
          '<span>' + escHtml(fmtDay(o.paid_at || o.created_at)) + ' · ' + escHtml(o.plan) + '</span>' +
          '<span class="' + (done ? 'ok' : 'wait') + '">' + o.amount_rub + ' ₽ · ' + escHtml(status[o.status] || o.status) + '</span>' +
        '</div>';
      }).join('');
    }).catch(function () {});
  }

  function loadFaq() {
    api('/api/app/faq').then(function (res) {
      var box = $('faq-list');
      if (!res.ok || !res.faq || !res.faq.length) {
        box.innerHTML = '<div class="empty">Раздел помощи скоро появится.</div>';
        return;
      }
      state.faq = res.faq;
      box.innerHTML = res.faq.map(function (item, index) {
        return '<div class="faq-item" data-faq="' + index + '" data-act="faq">' +
          '<div class="faq-q"><span>' + escHtml(item.q) + '</span>' +
            '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round"><polyline points="5 9 12 16 19 9"></polyline></svg>' +
          '</div>' +
          '<div class="faq-a">' + escHtml(item.a) + '</div>' +
        '</div>';
      }).join('');
    }).catch(function () {});
  }

  // ── загрузка состояния ───────────────────────────────────────────────
  function loadMe() {
    return api('/api/app/me').then(function (res) {
      if (!res.ok) { toast(res.error || 'Не удалось загрузить профиль'); return; }
      state.me = res.user;
      state.sub = res.subscription;
      state.traffic = res.traffic;
      state.devices = res.devices;
      state.metering = res.metering || { available: false };

      var hour = new Date().getHours();
      $('greet-word').textContent = hour < 5 ? 'Доброй ночи,' : hour < 12 ? 'Доброе утро,' : hour < 18 ? 'Добрый день,' : 'Добрый вечер,';
      $('greet-name').textContent = res.user.first_name || res.user.username || 'друг';

      $('ref-link').value = res.referrals.ref_link;
      $('ref-invited').textContent = res.referrals.invited;
      $('ref-days').textContent = '+' + (res.referrals.bonus_days || 0);

      renderHero();
      renderDevices(res.devices);
      renderCurrentPlan();
      loadPacks();
    }).catch(function () { toast('Ошибка сети'); });
  }

  function loadPlans() {
    api('/api/app/plans').then(function (res) {
      if (!res.ok) return;
      state.plans = (res.plans || []).filter(function (p) { return p.purchasable; });
      state.providers = res.providers || [];
      state.provider = state.providers.length ? state.providers[0].id : null;
      // По умолчанию — минимальный вход (месяц), а не «Популярный»: человек
      // не должен случайно открыть счёт на три месяца.
      state.selected = state.plans.length ? state.plans[0].code : null;
      renderProviders();
      renderPlans();
    }).catch(function () {});
  }

  // ── шторка: QR и инструкция ──────────────────────────────────────────
  function openSheet(html) {
    $('sheet-inner').innerHTML = html;
    $('sheet').classList.add('on');
  }

  function closeSheet() {
    $('sheet').classList.remove('on');
  }

  function subUrl() {
    return state.sub ? state.sub.sub_url : '';
  }

  function copyLink() {
    haptic();
    var url = subUrl();
    if (!url) return toast('Ссылка ещё не загружена');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast('Ссылка скопирована'); });
    } else {
      var input = document.createElement('textarea');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      toast('Ссылка скопирована');
    }
  }

  function showQr() {
    haptic();
    var url = subUrl();
    if (!url) return toast('Ссылка ещё не загружена');
    openSheet(
      '<div class="sheet-title">Подключение по QR</div>' +
      '<div class="qr-box"><img alt="QR" src="https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' + encodeURIComponent(url) + '"></div>' +
      '<p class="steps">Откройте приложение (Happ, INCY, v2rayNG) → «Добавить профиль» → «Сканировать QR-код».</p>' +
      '<button class="btn-olive" data-act="copy">Скопировать ссылку</button>'
    );
  }

  function showGuide() {
    haptic();
    openSheet(
      '<div class="sheet-title">Как подключить</div>' +
      '<ol class="steps">' +
        '<li>Нажмите <b>Скопировать</b> — ссылка подписки окажется в буфере обмена.</li>' +
        '<li>Установите <b>Happ</b> или <b>INCY</b> из App Store, Google Play или с сайта разработчика.</li>' +
        '<li>В приложении выберите <b>«Добавить профиль» → «Импорт из буфера обмена»</b>.</li>' +
        '<li>В списке появится <b>⚡ Авто-выбор</b> и серверы по странам. Включите авто-выбор.</li>' +
        '<li>Готово: одно устройство уже занимает слот. Сменить устройство можно в профиле.</li>' +
      '</ol>' +
      '<button class="btn-olive" data-act="copy">Скопировать ссылку</button>'
    );
  }

  // ── действия ─────────────────────────────────────────────────────────
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node !== document.body && !node.getAttribute) node = node.parentNode;
    var el = node && node.closest ? node.closest('[data-act]') : null;
    if (!el) return;

    var act = el.getAttribute('data-act');

    if (act === 'toggle-theme') { toggleTheme(); return; }
    if (act === 'tab') { switchTab(el.getAttribute('data-tab')); return; }
    if (act === 'select') {
      state.selected = el.getAttribute('data-code');
      haptic();
      renderPlans();
      return;
    }
    if (act === 'provider') {
      state.provider = el.getAttribute('data-id');
      haptic();
      renderProviders();
      return;
    }
    if (act === 'copy') { copyLink(); return; }
    if (act === 'qr') { showQr(); return; }
    if (act === 'guide' || act === 'connect') { showGuide(); return; }
    if (act === 'kick') {
      kickDevice(Number(el.getAttribute('data-id')), el.getAttribute('data-label') || 'устройство');
      return;
    }
    if (act === 'rename') {
      haptic();
      renameSheet(Number(el.getAttribute('data-id')), el.getAttribute('data-name') || '');
      return;
    }
    if (act === 'rename-guess') {
      saveDeviceName(Number(el.getAttribute('data-id')), el.getAttribute('data-name') || '');
      return;
    }
    if (act === 'rename-fill') {
      var fill = $('rename-input');
      if (fill) fill.value = el.getAttribute('data-name') || '';
      return;
    }
    if (act === 'rename-save') {
      var input = $('rename-input');
      saveDeviceName(Number(el.getAttribute('data-id')), String((input && input.value) || '').trim());
      return;
    }
    if (act === 'rename-clear') {
      saveDeviceName(Number(el.getAttribute('data-id')), '');
      return;
    }
    if (act === 'pack') { buyPack(el.getAttribute('data-code')); return; }
    if (act === 'pay') { pay(); return; }
    if (act === 'faq') { el.classList.toggle('open'); return; }
    if (act === 'support') {
      haptic();
      var link = 'https://t.me/${botUsername}';
      if (tg && tg.openTelegramLink) tg.openTelegramLink(link);
      else window.open(link, '_blank');
      return;
    }
    if (act === 'copy-ref') {
      haptic();
      var ref = $('ref-link').value;
      if (navigator.clipboard) navigator.clipboard.writeText(ref);
      toast('Реферальная ссылка скопирована');
      return;
    }
    if (act === 'share-ref') {
      haptic();
      var ref = $('ref-link').value;
      var text = 'Подключайся к Апельсинка VPN — быстрый VPN без блокировок: ' + ref;
      var share = 'https://t.me/share/url?url=' + encodeURIComponent(ref) + '&text=' + encodeURIComponent(text);
      if (tg && tg.openTelegramLink) tg.openTelegramLink(share);
      else window.open(share, '_blank');
      return;
    }
    if (act === 'promo') {
      haptic();
      var input = $('promo-input');
      var code = String(input.value || '').trim();
      if (!code) return toast('Введите код');
      api('/api/app/promo/claim', { method: 'POST', body: JSON.stringify({ code: code }) }).then(function (res) {
        if (res.ok) {
          toast(res.message || 'Промокод активирован');
          input.value = '';
          loadMe();
        } else {
          toast(res.error || 'Ошибка активации');
        }
      }).catch(function () { toast('Ошибка сети'); });
      return;
    }
    if (act === 'pick-promo') {
      switchTab('profile');
      setTimeout(function () { var el = $('promo-input'); if (el) el.focus(); }, 320);
      return;
    }
    if (act === 'bonus') {
      haptic('medium');
      api('/api/app/daily/claim', { method: 'POST' }).then(function (res) {
        if (res.ok) { toast(res.message || 'Бонус получен'); loadMe(); }
        else toast(res.error || 'Бонус уже получен');
      }).catch(function () { toast('Ошибка сети'); });
      return;
    }
  });

  $('sheet').addEventListener('click', function (event) {
    if (event.target === $('sheet')) closeSheet();
  });

  loadMe();
  loadPlans();
  loadOrders();
  loadFaq();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
