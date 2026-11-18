-- 0028: витрина тарифов.
--
-- Решение владельца: пробник 7 дней бесплатно, месяц 190 ₽, дальше — та же
-- цена за месяц с понижением при больших сроках, год со скидкой. Трафик
-- безлимитный на всех тарифах (traffic_gb = NULL), ограничение — только срок.

UPDATE plans SET
  days = 7,
  price_rub = 0,
  device_limit = 2,
  traffic_gb = NULL,
  sort = 10,
  active = 1,
  note = 'Пробный доступ на неделю, 2 устройства',
  badge = '',
  featured = 0
WHERE code = 'trial';

UPDATE plans SET
  days = 30,
  price_rub = 190,
  device_limit = 3,
  traffic_gb = NULL,
  sort = 20,
  active = 1,
  note = 'Все серверы, 3 устройства, трафик без лимита',
  badge = '',
  featured = 0
WHERE code = 'month';

UPDATE plans SET
  days = 365,
  price_rub = 1590,
  device_limit = 5,
  traffic_gb = NULL,
  sort = 60,
  active = 1,
  note = '133 ₽ в месяц вместо 190 ₽, 5 устройств',
  badge = '−30%',
  featured = 0
WHERE code = 'year';

UPDATE plans SET
  days = 60, price_rub = 360, device_limit = 3, traffic_gb = NULL, sort = 30, active = 1,
  note = '180 ₽ в месяц', badge = '', featured = 0
WHERE code = 'm2';

UPDATE plans SET
  days = 90, price_rub = 510, device_limit = 3, traffic_gb = NULL, sort = 40, active = 1,
  note = '170 ₽ в месяц', badge = 'Популярный', featured = 1
WHERE code = 'm3';

UPDATE plans SET
  days = 180, price_rub = 900, device_limit = 3, traffic_gb = NULL, sort = 50, active = 1,
  note = '150 ₽ в месяц', badge = 'Выгодно', featured = 0
WHERE code = 'm6';

INSERT OR IGNORE INTO plans
  (code, title, days, price_rub, device_limit, traffic_gb, active, sort, note, badge, featured)
VALUES
  ('m2', '2 месяца', 60, 360, 3, NULL, 1, 30, '180 ₽ в месяц', '', 0),
  ('m3', '3 месяца', 90, 510, 3, NULL, 1, 40, '170 ₽ в месяц', 'Популярный', 1),
  ('m6', '6 месяцев', 180, 900, 3, NULL, 1, 50, '150 ₽ в месяц', 'Выгодно', 0);
