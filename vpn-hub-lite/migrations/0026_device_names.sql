-- 0026: своё имя устройства и сырой User-Agent.
--
-- Клиенты (Happ, INCY, v2rayNG) в большинстве случаев не присылают модель
-- телефона: в UA остаётся только «Android 14» или вообще ничего, поэтому
-- в кабинете появлялось «Устройство · Клиент». Человек сам называет
-- устройство, а сырой UA храним, чтобы разбор имён можно было улучшать.

ALTER TABLE user_devices ADD COLUMN custom_name TEXT;
ALTER TABLE user_devices ADD COLUMN user_agent TEXT;
