/**
 * Профиль маршрутизации Happ: Россия — напрямую, всё остальное — через VPN.
 *
 * Как это работает: Happ принимает профиль в заголовке `routing` подписки
 * в виде `happ://routing/onadd/<base64 JSON>`. Приложение скачивает геофайлы
 * (geoip.dat, geosite.dat) и дальше само решает, что пускать в туннель.
 *
 * Почему onadd, а не add: add кладёт профиль в список, но не включает его,
 * если у человека уже есть свой. Нам нужно, чтобы правило заработало сразу
 * после обновления подписки — иначе смысла в нём нет.
 */

/** Адрес воркера: с него отдаются нарезки геофайлов. */
const GEO_ORIGIN = "https://vpn-hub-lite.twistx-launcher.workers.dev";

/** Домены, которые должны идти мимо туннеля в любом случае. */
const DIRECT_DOMAINS = [
  // Российские домены в других зонах (.com, .net) — из нашей нарезки geosite.
  "geosite:category-ru",
  // Зона целиком: покрывает всё, чего нет ни в одном списке.
  "domain:ru",
  "domain:su",

  // Белый список: сервисы, которые в РФ работают и без VPN. Если гнать их
  // через туннель, они начинают капризничать — банк видит чужую страну,
  // госсервис просит подтверждение, видео упирается в регион. Домены в
  // зонах .com/.net/.me сюда попадают только явным перечислением.
  "vk.com",
  "vk.me",
  "ok.ru",
  "mail.ru",
  "max.ru",
  "ya.ru",
  "dzen.ru",
  "rutube.ru",
  "kinopoisk.ru",
  "ivi.ru",
  "wink.ru",
  "sferum.ru",
  "rt.ru",
  "mts.ru",
  "megafon.ru",
  "beeline.ru",
  "t2.ru",
  "yota.ru",
  "ozon.ru",
  "wildberries.ru",
  "avito.ru",
  "dns-shop.ru",
  "sber.ru",
  "tbank.ru",
  "vtb.ru",
  "alfabank.ru",
  "gazprombank.ru",
  "psbank.ru",
  "mkb.ru",
  "gosuslugi.ru",
  "nalog.gov.ru",
  "mos.ru",
  "mvd.ru",
  "pfr.gov.ru",
  "cbr.ru",
  "rzd.ru",
  "aeroflot.ru",
  "pochta.ru",
  "2gis.ru",
  "kaspersky.ru",
  "drweb.ru",
];

const DIRECT_IPS = [
  "geoip:ru",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255",
];

/**
 * Сам профиль. Ключи с большой буквы — так в документации Happ,
 * и приложение ждёт именно этот регистр.
 */
const PROFILE = {
  // Имя с версией — вынужденно. Happ обновляет профиль по имени, а удалённый
  // после ошибки профиль с прежним именем обратно не импортировался. Новое
  // имя приложение видит как новый профиль и ставит его с нуля.
  Name: "RU Direct v2",
  // Метка сборки: Happ считает профиль новым только если это значение
  // больше предыдущего.
  LastUpdated: "1792993759",
  GlobalProxy: "true",
  RemoteDNSType: "DoH",
  RemoteDNSDomain: "https://cloudflare-dns.com/dns-query",
  RemoteDNSIP: "1.1.1.1",
  // Для прямых запросов — российский DNS: он отдаёт локальные адреса,
  // а не зарубежные зеркала, из-за которых банки и ругаются.
  DomesticDNSType: "DoU",
  DomesticDNSDomain: "",
  DomesticDNSIP: "77.88.8.8",
  // Геофайлы отдаём сами, нарезками. Полные сборки Loyalsoldier весят 16 МБ
  // (geoip) и 11 МБ (geosite) — Happ не успевает скачать второй за три минуты
  // и валит ядро с ошибкой «отсутствует секция ADS». Здесь только Россия в
  // geoip (~400 КБ) и минимум в geosite (~25 КБ), причём с обязательной для
  // ядра секцией category-ads-all.
  Geoipurl: `${GEO_ORIGIN}/geo/v3/geoip.dat`,
  Geositeurl: `${GEO_ORIGIN}/geo/g4/geosite.dat`,
  // Адрес DoH-сервера задаём напрямую: иначе первое разрешение имени
  // уходит в тот же DNS, который мы ещё не настроили, и правило по домену
  // может не сработать. В профиле по умолчанию у Happ здесь ровно это.
  DnsHosts: { "cloudflare-dns.com": "1.1.1.1" } as Record<string, string>,
  DirectSites: DIRECT_DOMAINS,
  DirectIp: DIRECT_IPS,
  ProxySites: [] as string[],
  ProxyIp: [] as string[],
  BlockSites: [] as string[],
  BlockIp: [] as string[],
  DomainStrategy: "IPIfNonMatch",
  FakeDNS: "false",
};

/** Ссылка для заголовка `routing`. Профиль ASCII, поэтому btoa безопасен. */
export function routingLink(): string {
  return `happ://routing/onadd/${btoa(JSON.stringify(PROFILE))}`;
}

/** Тот же профиль в base64 — для отдачи в теле или для отладки. */
export function routingProfile(): typeof PROFILE {
  return PROFILE;
}
