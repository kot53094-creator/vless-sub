/**
 * HTTP-запрос через локальный SOCKS5 (порт, который слушает Xray).
 *
 * Зачем свой клиент вместо curl: запуск внешнего процесса на Windows может
 * упасть с EPERM, и тогда живой узел получает «fail». Здесь всё делается
 * сокетом — быстрее, без внешних зависимостей и с понятной причиной отказа.
 */

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

export function socksRequest(port, url, timeoutMs = 12000, stopAtHeaders = false) {
  return new Promise((resolve) => {
    const started = Date.now();
    const target = new URL(url);
    const useTls = target.protocol === "https:";
    const destPort = Number(target.port || (useTls ? 443 : 80));
    const hostname = target.hostname;
    const reqPath = `${target.pathname || "/"}${target.search || ""}`;
    const request =
      `GET ${reqPath} HTTP/1.1\r\n` +
      `Host: ${hostname}\r\n` +
      "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n" +
      "Accept: */*\r\n" +
      "Connection: close\r\n\r\n";

    let settled = false;
    let stage = "greet";
    let buf = Buffer.alloc(0);
    let status = 0;
    let body = Buffer.alloc(0);
    let active = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        active?.destroy();
      } catch {
        /* сокет мог уже закрыться */
      }
      resolve(value);
    };
    const fail = (error) => finish({ status: 0, body: "", error, latency: null });

    const timer = setTimeout(() => fail("timeout"), timeoutMs);

    // Отдельная функция: её же снимаем перед переходом на TLS.
    const onEnd = () =>
      finish({
        status,
        body: body.toString("utf8"),
        error: null,
        latency: Date.now() - started,
      });

    const raw = netConnect({ host: "127.0.0.1", port });
    active = raw;
    raw.on("error", (error) => fail(error.code ?? "sock"));
    raw.on("connect", () => raw.write(Buffer.from([0x05, 0x01, 0x00])));

    const onData = (chunk) => {
      if (process.env.DEBUG_SOCKS) console.error("[socks] data", stage, chunk.length);
      buf = Buffer.concat([buf, chunk]);

      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail("socks-auth");
        buf = buf.subarray(2);
        const nameLen = Buffer.byteLength(hostname);
        stage = "reply";
        raw.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, nameLen]),
            Buffer.from(hostname, "utf8"),
            Buffer.from([destPort >> 8, destPort & 0xff]),
          ]),
        );
        return;
      }

      if (stage === "reply") {
        if (buf.length < 4) return;
        const atyp = buf[3];
        let addrLen;
        if (atyp === 0x01) addrLen = 4;
        else if (atyp === 0x04) addrLen = 16;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          addrLen = 1 + buf[4];
        } else return fail("socks-atyp");

        const need = 4 + addrLen + 2;
        if (buf.length < need) return;
        // Код ответа: 0 — туннель открыт, остальное — отказ узла.
        if (buf[1] !== 0x00) return fail(`socks-${buf[1]}`);
        buf = buf.subarray(need);
        stage = "http";

        if (useTls) {
          // Снимаем свои обработчики с сырого сокета: иначе два читателя
          // конкурируют за один поток, TLS недополучает байты и рукопожатие
          // падает с ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC. Узел при
          // этом живой — curl через тот же Xray отдаёт 204.
          raw.removeAllListeners("data");
          raw.removeAllListeners("end");
          // Обязательно: сокет остаётся в режиме flowing, и первые байты
          // ответа уходят «в никуда», пока TLS ещё не подписался на поток.
          // Из-за этого рукопожатие падало с ошибкой расшифровки, хотя узел
          // живой.
          raw.pause();
          const secure = tlsConnect({
            socket: raw,
            servername: hostname,
            rejectUnauthorized: false,
            ALPNProtocols: ["http/1.1"],
          });
          active = secure;
          secure.on("error", (error) => fail(error.code ?? "tls"));
          secure.on("data", onData);
          secure.on("end", () =>
            finish({
              status,
              body: body.toString("utf8"),
              error: null,
              latency: Date.now() - started,
            }),
          );
          // Именно secureConnect: "connect" у TLS-обёртки относится к TCP, который
          // уже установлен, и не наступает — запрос просто не уходил.
          secure.on("secureConnect", () => { if (process.env.DEBUG_SOCKS) console.error("[socks] secureConnect", secure.getProtocol?.()); secure.write(request); });
          return;
        }
        raw.write(request);
      }

      if (stage === "http") {
        if (!status) {
          const sep = buf.indexOf("\r\n\r\n");
          if (sep < 0) {
            if (buf.length > 65536) return fail("headers");
            return;
          }
          const head = buf.subarray(0, sep).toString("latin1");
          status = Number(head.split("\r\n")[0].split(" ")[1] ?? 0) || 0;
          // Для проверки живости тело не нужно: ждать закрытия соединения —
          // значит завысить задержку в разы (сервер держит сокет открытым).
          if (stopAtHeaders) {
            return finish({ status, body: "", error: null, latency: Date.now() - started });
          }
          body = Buffer.concat([body, buf.subarray(sep + 4)]);
        } else {
          body = Buffer.concat([body, buf]);
        }
        buf = Buffer.alloc(0);
      }
    };

    raw.on("data", onData);
    raw.on("end", onEnd);
  });
}

/**
 * Проверка TCP-доступности адреса через SOCKS5, без HTTP.
 *
 * Нужна для Телеграма: он работает не по HTTP, и запрос к api.telegram.org
 * отвечает 200 даже там, где MTProto заблокирован. Единственный честный
 * признак — получается ли TCP-соединение до дата-центра Telegram.
 */
export function socksTcp(port, host, destPort, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let buf = Buffer.alloc(0);
    let stage = "greet";
    const sock = netConnect({ host: "127.0.0.1", port });

    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      resolve({ ok, error: error ?? null, latency: ok ? Date.now() - started : null });
    };
    const timer = setTimeout(() => done(false, "timeout"), timeoutMs);
    sock.on("error", (e) => done(false, e.code ?? "sock"));
    sock.on("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])));

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return done(false, "socks-auth");
        buf = buf.subarray(2);
        const name = Buffer.byteLength(host);
        sock.write(Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name]),
          Buffer.from(host, "utf8"),
          Buffer.from([destPort >> 8, destPort & 0xff]),
        ]));
        stage = "reply";
        return;
      }
      if (buf.length < 5) return;
      const atyp = buf[3];
      let addrLen;
      if (atyp === 0x01) addrLen = 4;
      else if (atyp === 0x04) addrLen = 16;
      else if (atyp === 0x03) addrLen = 1 + buf[4];
      else return done(false, "socks-atyp");
      if (buf.length < 4 + addrLen + 2) return;
      if (buf[1] !== 0x00) return done(false, `socks-${buf[1]}`);
      done(true, null);
    });

  });
}
