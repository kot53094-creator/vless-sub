import pathlib

admin = pathlib.Path("src/admin.ts")
src = admin.read_text(encoding="utf-8")

start_marker = "async function serversPage(env: Env): Promise<Response> {"
end_marker = '  return page("Серверы", body, "servers", env);\n}'

start = src.index(start_marker)
end = src.index(end_marker, start) + len(end_marker)

new_page = pathlib.Path("scripts/new_servers_page.ts").read_text(encoding="utf-8").rstrip() + "\n"

src = src[:start] + new_page + src[end:]
admin.write_text(src, encoding="utf-8")
print("replaced", end - start, "->", len(new_page))
