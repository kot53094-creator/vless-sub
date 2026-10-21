// Загрузка источников через админ-API. Запуск: node scripts/add_sources.mjs
const BASE = "https://vpn-hub-lite.twistx-launcher.workers.dev";
const COOKIE = "vh_admin=359958b93f58e0eee01974435ba3b9bdf1549ec18fc21a0f4754a78ae56899cb";
const CSRF = "87a93f28bd7cbc0581dbaffe";

const SOURCES = [
  ["RU · igareck black vless", "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt"],
  ["RU · igareck black mobile", "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS_mobile.txt"],
  ["RU · goida 26", "https://github.com/AvenCores/goida-vpn-configs/raw/refs/heads/main/githubmirror/26.txt"],

  ["WL · reality white mobile", "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/Vless-Reality-White-Lists-Rus-Mobile.txt"],
  ["WL · white cidr ru", "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/WHITE-CIDR-RU-checked.txt"],
  ["WL · white sni ru", "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/WHITE-SNI-RU-all.txt"],
  ["WL · byewhitelists2", "https://raw.githubusercontent.com/ByeWhiteLists/ByeWhiteLists2/refs/heads/main/ByeWhiteLists2.txt"],
  ["WL · ru white part3", "https://raw.githubusercontent.com/kort0881/vpn-checker-backend/main/checked/RU_Best/ru_white_part3.txt"],

  ["INT · radikal top100", "https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/top100.txt"],
  ["INT · radikal vless", "https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/protocols/vless.txt"],
  ["INT · epodonios all", "https://github.com/Epodonios/v2ray-configs/raw/main/All_Configs_Sub.txt"],
  ["INT · delta kronecker", "https://github.com/Delta-Kronecker/V2ray-Config/raw/refs/heads/main/config/all_configs.txt"],
  ["INT · au1rxx base64", "https://github.com/Au1rxx/free-vpn-subscriptions/raw/main/output/v2ray-base64.txt"],
];

async function post(fields) {
  const body = new URLSearchParams({ csrf: CSRF, ...fields }).toString();
  const response = await fetch(`${BASE}/admin/action`, {
    method: "POST",
    headers: { cookie: COOKIE, "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  const location = response.headers.get("location") ?? "";
  return decodeURIComponent(location.replace(/\+/g, " "));
}

for (const [name, url] of SOURCES) {
  try {
    const message = await post({ action: "add_source", name, kind: "public", url });
    console.log(`${name}\n   ${message.split("?").slice(1).join("?") || message}`);
  } catch (error) {
    console.log(`${name}\n   ERROR ${error.message}`);
  }
}
