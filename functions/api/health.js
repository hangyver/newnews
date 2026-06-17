export async function onRequestGet() {
  return Response.json({
    ok: true,
    service: "newnews-pages",
    now: new Date().toISOString(),
  });
}
