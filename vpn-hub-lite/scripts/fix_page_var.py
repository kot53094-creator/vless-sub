import pathlib
import re

p = pathlib.Path("src/admin.ts")
s = p.read_text(encoding="utf-8")

# Локальная переменная page перекрывала функцию page() из шаблона.
s = s.replace(
    'const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);',
    'const pageNo = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);',
)
s = s.replace("(page - 1) * per", "(pageNo - 1) * per")
s = s.replace("${page > 1 ?", "${pageNo > 1 ?")
s = s.replace("${page < pages ?", "${pageNo < pages ?")
s = s.replace("page=${page - 1}", "page=${pageNo - 1}")
s = s.replace("page=${page + 1}", "page=${pageNo + 1}")
s = s.replace("страница ${page} из", "страница ${pageNo} из")

# Роутер должен передавать URL с фильтрами.
s = s.replace("return await serversPage(env);", "return await serversPage(env, url);")

p.write_text(s, encoding="utf-8")
left = re.findall(r"\$\{page\b(?!No)", s)
print("ok, осталось старых ссылок:", len(left))
