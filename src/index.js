// Tiempos del equipo: API en un Worker de Cloudflare con base de datos D1.
// Cada instalación es un solo espacio de trabajo: la primera persona que entra es la Responsable.

const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT)`,
  `CREATE TABLE IF NOT EXISTS personas (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE COLLATE NOCASE,
     nombre TEXT NOT NULL,
     clave_hash TEXT NOT NULL,
     sal TEXT NOT NULL,
     rol TEXT NOT NULL CHECK (rol IN ('responsable','equipo')),
     activa INTEGER NOT NULL DEFAULT 1,
     creada INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sesiones (
     token TEXT PRIMARY KEY,
     persona_id INTEGER NOT NULL,
     caduca INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invitaciones (
     token TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     creada INTEGER NOT NULL,
     usada INTEGER)`,
  `CREATE TABLE IF NOT EXISTS clientes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     nombre TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#507479',
     archivado INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS proyectos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     cliente_id INTEGER NOT NULL,
     nombre TEXT NOT NULL,
     archivado INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS tiempos (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     persona_id INTEGER NOT NULL,
     proyecto_id INTEGER,
     descripcion TEXT NOT NULL DEFAULT '',
     inicio INTEGER NOT NULL,
     fin INTEGER,
     creado INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tiempos_persona_inicio ON tiempos (persona_id, inicio)`,
  `CREATE INDEX IF NOT EXISTS tiempos_inicio ON tiempos (inicio)`,
  `CREATE TABLE IF NOT EXISTS meses_cerrados (mes TEXT PRIMARY KEY, cerrado INTEGER NOT NULL)`,
];

let esquemaListo = false;
async function prepararBase(env) {
  if (esquemaListo) return;
  await env.DB.batch(ESQUEMA.map((s) => env.DB.prepare(s)));
  esquemaListo = true;
}

// ---------- utilidades ----------

class ErrorApi extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}
const fallo = (estado, mensaje) => {
  throw new ErrorApi(estado, mensaje);
};

function json(datos, estado = 200, cabeceras = {}) {
  return new Response(JSON.stringify(datos), {
    status: estado,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cabeceras },
  });
}

function aleatorio(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashClave(clave, salB64) {
  const sal = Uint8Array.from(atob(salB64), (c) => c.charCodeAt(0));
  const llave = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: sal, iterations: 100000, hash: 'SHA-256' }, llave, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function nuevaSal() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

function iguales(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function texto(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function validarEmail(email) {
  const e = texto(email, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fallo(400, 'Ese email no parece correcto.');
  return e;
}

function validarClave(clave) {
  if (typeof clave !== 'string' || clave.length < 8) fallo(400, 'La contraseña tiene que tener al menos 8 caracteres.');
  return clave;
}

function validarColor(c) {
  return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#507479';
}

// Mes (AAAA-MM) de un instante, en la zona horaria del espacio
function mesDe(ms, zona) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zona, year: 'numeric', month: '2-digit' }).formatToParts(new Date(ms));
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

const DURACION_SESION = 30 * 24 * 3600 * 1000;

function cookieSesion(token, req) {
  const segura = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACION_SESION / 1000}${segura}`;
}

async function crearSesion(env, personaId, req) {
  const token = aleatorio(32);
  await env.DB.prepare('INSERT INTO sesiones (token, persona_id, caduca) VALUES (?, ?, ?)')
    .bind(token, personaId, Date.now() + DURACION_SESION).run();
  return cookieSesion(token, req);
}

async function personaDeSesion(env, req) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sesion=([^;]+)/);
  if (!m) return null;
  const fila = await env.DB.prepare(
    `SELECT p.id, p.email, p.nombre, p.rol, p.activa, s.caduca FROM sesiones s
     JOIN personas p ON p.id = s.persona_id WHERE s.token = ?`
  ).bind(m[1]).first();
  if (!fila || fila.caduca < Date.now() || !fila.activa) return null;
  return { id: fila.id, email: fila.email, nombre: fila.nombre, rol: fila.rol, token: m[1] };
}

async function mesCerrado(env, mes) {
  const f = await env.DB.prepare('SELECT cerrado FROM meses_cerrados WHERE mes = ?').bind(mes).first();
  return !!(f && f.cerrado);
}

// El Equipo no puede tocar tiempos de un mes cerrado. La Responsable sí.
async function comprobarMes(env, persona, ...instantes) {
  if (persona.rol === 'responsable') return;
  for (const ms of instantes) {
    if (ms == null) continue;
    if (await mesCerrado(env, mesDe(ms, env.ZONA_HORARIA || 'Europe/Madrid'))) {
      fallo(403, 'Ese mes está cerrado. Si hay que cambiar algo, pídeselo a la Responsable.');
    }
  }
}

async function comprobarProyecto(env, proyectoId) {
  if (proyectoId == null) return null;
  const id = Number(proyectoId);
  const p = await env.DB.prepare('SELECT id FROM proyectos WHERE id = ?').bind(id).first();
  if (!p) fallo(400, 'Ese proyecto no existe.');
  return id;
}

async function leerCuerpo(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ---------- rutas ----------

async function manejarApi(req, env, url) {
  await prepararBase(env);
  const ruta = url.pathname.replace(/^\/api/, '');
  const metodo = req.method;
  const cuerpo = metodo === 'GET' ? {} : await leerCuerpo(req);

  // --- sin sesión ---
  if (ruta === '/estado' && metodo === 'GET') {
    const hay = await env.DB.prepare('SELECT COUNT(*) n FROM personas').first();
    const persona = await personaDeSesion(env, req);
    const nombre = await env.DB.prepare("SELECT valor FROM ajustes WHERE clave = 'espacio'").first();
    return json({
      configurado: hay.n > 0,
      espacio: nombre ? nombre.valor : '',
      zona: env.ZONA_HORARIA || 'Europe/Madrid',
      persona: persona ? { id: persona.id, email: persona.email, nombre: persona.nombre, rol: persona.rol } : null,
    });
  }

  if (ruta === '/configurar' && metodo === 'POST') {
    const hay = await env.DB.prepare('SELECT COUNT(*) n FROM personas').first();
    if (hay.n > 0) fallo(409, 'Este espacio ya está creado. Entra con tu email y contraseña.');
    const espacio = texto(cuerpo.espacio, 80) || 'Mi equipo';
    const nombre = texto(cuerpo.nombre, 80);
    if (!nombre) fallo(400, 'Escribe tu nombre.');
    const email = validarEmail(cuerpo.email);
    const clave = validarClave(cuerpo.clave);
    const sal = nuevaSal();
    const r = await env.DB.prepare(
      "INSERT INTO personas (email, nombre, clave_hash, sal, rol, creada) VALUES (?, ?, ?, ?, 'responsable', ?)"
    ).bind(email, nombre, await hashClave(clave, sal), sal, Date.now()).run();
    await env.DB.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('espacio', ?)").bind(espacio).run();
    const cookie = await crearSesion(env, r.meta.last_row_id, req);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  if (ruta === '/entrar' && metodo === 'POST') {
    const email = texto(cuerpo.email, 200).toLowerCase();
    const p = await env.DB.prepare('SELECT * FROM personas WHERE email = ?').bind(email).first();
    const ok = p && p.activa && iguales(await hashClave(String(cuerpo.clave || ''), p.sal), p.clave_hash);
    if (!ok) fallo(401, 'El email o la contraseña no coinciden.');
    const cookie = await crearSesion(env, p.id, req);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  const invitacion = ruta.match(/^\/invitacion\/([\w-]+)$/);
  if (invitacion && metodo === 'GET') {
    const inv = await env.DB.prepare('SELECT email, usada FROM invitaciones WHERE token = ?').bind(invitacion[1]).first();
    if (!inv || inv.usada) fallo(404, 'Esta invitación ya no vale. Pide otra a la Responsable.');
    const nombre = await env.DB.prepare("SELECT valor FROM ajustes WHERE clave = 'espacio'").first();
    return json({ email: inv.email, espacio: nombre ? nombre.valor : '' });
  }

  if (ruta === '/unirse' && metodo === 'POST') {
    const token = texto(cuerpo.token, 100);
    const inv = await env.DB.prepare('SELECT email, usada FROM invitaciones WHERE token = ?').bind(token).first();
    if (!inv || inv.usada) fallo(404, 'Esta invitación ya no vale. Pide otra a la Responsable.');
    const nombre = texto(cuerpo.nombre, 80);
    if (!nombre) fallo(400, 'Escribe tu nombre.');
    const clave = validarClave(cuerpo.clave);
    const existe = await env.DB.prepare('SELECT id FROM personas WHERE email = ?').bind(inv.email).first();
    if (existe) fallo(409, 'Ya hay una cuenta con este email. Entra con tu contraseña.');
    const sal = nuevaSal();
    const r = await env.DB.prepare(
      "INSERT INTO personas (email, nombre, clave_hash, sal, rol, creada) VALUES (?, ?, ?, ?, 'equipo', ?)"
    ).bind(inv.email, nombre, await hashClave(clave, sal), sal, Date.now()).run();
    await env.DB.prepare('UPDATE invitaciones SET usada = ? WHERE token = ?').bind(Date.now(), token).run();
    const cookie = await crearSesion(env, r.meta.last_row_id, req);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  // --- con sesión ---
  const yo = await personaDeSesion(env, req);
  if (!yo) fallo(401, 'Tienes que entrar otra vez.');
  const esResp = yo.rol === 'responsable';
  const soloResp = () => {
    if (!esResp) fallo(403, 'Esto solo lo puede hacer la Responsable.');
  };

  if (ruta === '/salir' && metodo === 'POST') {
    await env.DB.prepare('DELETE FROM sesiones WHERE token = ?').bind(yo.token).run();
    return json({ ok: true }, 200, { 'set-cookie': 'sesion=; Path=/; Max-Age=0' });
  }

  if (ruta === '/mi-clave' && metodo === 'POST') {
    const p = await env.DB.prepare('SELECT * FROM personas WHERE id = ?').bind(yo.id).first();
    if (!iguales(await hashClave(String(cuerpo.actual || ''), p.sal), p.clave_hash)) fallo(400, 'La contraseña actual no es esa.');
    const sal = nuevaSal();
    await env.DB.prepare('UPDATE personas SET clave_hash = ?, sal = ? WHERE id = ?')
      .bind(await hashClave(validarClave(cuerpo.nueva), sal), sal, yo.id).run();
    return json({ ok: true });
  }

  // Espacio
  if (ruta === '/espacio' && metodo === 'PATCH') {
    soloResp();
    const espacio = texto(cuerpo.espacio, 80);
    if (!espacio) fallo(400, 'Escribe un nombre.');
    await env.DB.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('espacio', ?)").bind(espacio).run();
    return json({ ok: true });
  }

  // Clientes y proyectos: todo el mundo los lee, solo la Responsable los cambia
  if (ruta === '/catalogo' && metodo === 'GET') {
    const clientes = await env.DB.prepare('SELECT * FROM clientes ORDER BY archivado, nombre COLLATE NOCASE').all();
    const proyectos = await env.DB.prepare('SELECT * FROM proyectos ORDER BY archivado, nombre COLLATE NOCASE').all();
    return json({ clientes: clientes.results, proyectos: proyectos.results });
  }

  if (ruta === '/clientes' && metodo === 'POST') {
    soloResp();
    const nombre = texto(cuerpo.nombre, 80);
    if (!nombre) fallo(400, 'Escribe el nombre del cliente.');
    const r = await env.DB.prepare('INSERT INTO clientes (nombre, color) VALUES (?, ?)').bind(nombre, validarColor(cuerpo.color)).run();
    return json({ id: r.meta.last_row_id });
  }
  const cliente = ruta.match(/^\/clientes\/(\d+)$/);
  if (cliente && metodo === 'PATCH') {
    soloResp();
    const actual = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(+cliente[1]).first();
    if (!actual) fallo(404, 'Ese cliente no existe.');
    await env.DB.prepare('UPDATE clientes SET nombre = ?, color = ?, archivado = ? WHERE id = ?').bind(
      texto(cuerpo.nombre, 80) || actual.nombre,
      cuerpo.color ? validarColor(cuerpo.color) : actual.color,
      cuerpo.archivado == null ? actual.archivado : cuerpo.archivado ? 1 : 0,
      actual.id
    ).run();
    return json({ ok: true });
  }

  if (ruta === '/proyectos' && metodo === 'POST') {
    soloResp();
    const nombre = texto(cuerpo.nombre, 80);
    if (!nombre) fallo(400, 'Escribe el nombre del proyecto.');
    const c = await env.DB.prepare('SELECT id FROM clientes WHERE id = ?').bind(Number(cuerpo.cliente_id)).first();
    if (!c) fallo(400, 'Elige un cliente.');
    const r = await env.DB.prepare('INSERT INTO proyectos (cliente_id, nombre) VALUES (?, ?)').bind(c.id, nombre).run();
    return json({ id: r.meta.last_row_id });
  }
  const proyecto = ruta.match(/^\/proyectos\/(\d+)$/);
  if (proyecto && metodo === 'PATCH') {
    soloResp();
    const actual = await env.DB.prepare('SELECT * FROM proyectos WHERE id = ?').bind(+proyecto[1]).first();
    if (!actual) fallo(404, 'Ese proyecto no existe.');
    let clienteId = actual.cliente_id;
    if (cuerpo.cliente_id != null) {
      const c = await env.DB.prepare('SELECT id FROM clientes WHERE id = ?').bind(Number(cuerpo.cliente_id)).first();
      if (!c) fallo(400, 'Elige un cliente.');
      clienteId = c.id;
    }
    await env.DB.prepare('UPDATE proyectos SET nombre = ?, cliente_id = ?, archivado = ? WHERE id = ?').bind(
      texto(cuerpo.nombre, 80) || actual.nombre,
      clienteId,
      cuerpo.archivado == null ? actual.archivado : cuerpo.archivado ? 1 : 0,
      actual.id
    ).run();
    return json({ ok: true });
  }

  // Cronómetro
  if (ruta === '/cronometro' && metodo === 'GET') {
    const t = await env.DB.prepare('SELECT * FROM tiempos WHERE persona_id = ? AND fin IS NULL').bind(yo.id).first();
    return json({ enMarcha: t || null });
  }
  if (ruta === '/cronometro/empezar' && metodo === 'POST') {
    const ahora = Date.now();
    await comprobarMes(env, yo, ahora);
    const proyectoId = await comprobarProyecto(env, cuerpo.proyecto_id);
    const enMarcha = await env.DB.prepare('SELECT id FROM tiempos WHERE persona_id = ? AND fin IS NULL').bind(yo.id).first();
    if (enMarcha) {
      // Se para el anterior antes de empezar otro: solo puede haber uno en marcha
      await env.DB.prepare('UPDATE tiempos SET fin = ? WHERE id = ?').bind(ahora, enMarcha.id).run();
    }
    const r = await env.DB.prepare(
      'INSERT INTO tiempos (persona_id, proyecto_id, descripcion, inicio, fin, creado) VALUES (?, ?, ?, ?, NULL, ?)'
    ).bind(yo.id, proyectoId, texto(cuerpo.descripcion, 300), ahora, ahora).run();
    return json({ id: r.meta.last_row_id, inicio: ahora });
  }
  if (ruta === '/cronometro/parar' && metodo === 'POST') {
    const t = await env.DB.prepare('SELECT * FROM tiempos WHERE persona_id = ? AND fin IS NULL').bind(yo.id).first();
    if (!t) return json({ ok: true });
    await env.DB.prepare('UPDATE tiempos SET fin = ?, descripcion = ?, proyecto_id = ? WHERE id = ?').bind(
      Math.max(Date.now(), t.inicio + 1000),
      cuerpo.descripcion != null ? texto(cuerpo.descripcion, 300) : t.descripcion,
      cuerpo.proyecto_id !== undefined ? await comprobarProyecto(env, cuerpo.proyecto_id) : t.proyecto_id,
      t.id
    ).run();
    return json({ ok: true });
  }

  // Tiempos
  if (ruta === '/tiempos' && metodo === 'GET') {
    const desde = Number(url.searchParams.get('desde')) || 0;
    const hasta = Number(url.searchParams.get('hasta')) || 8.64e15;
    const r = await env.DB.prepare(
      'SELECT * FROM tiempos WHERE persona_id = ? AND inicio >= ? AND inicio < ? AND fin IS NOT NULL ORDER BY inicio DESC'
    ).bind(yo.id, desde, hasta).all();
    return json({ tiempos: r.results });
  }
  if (ruta === '/tiempos' && metodo === 'POST') {
    const inicio = Number(cuerpo.inicio);
    const fin = Number(cuerpo.fin);
    if (!inicio || !fin || fin <= inicio) fallo(400, 'Revisa las horas: el final tiene que ir después del inicio.');
    if (fin - inicio > 24 * 3600 * 1000) fallo(400, 'Un tiempo no puede durar más de 24 horas.');
    await comprobarMes(env, yo, inicio);
    const proyectoId = await comprobarProyecto(env, cuerpo.proyecto_id);
    const r = await env.DB.prepare(
      'INSERT INTO tiempos (persona_id, proyecto_id, descripcion, inicio, fin, creado) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(yo.id, proyectoId, texto(cuerpo.descripcion, 300), inicio, fin, Date.now()).run();
    return json({ id: r.meta.last_row_id });
  }
  const tiempo = ruta.match(/^\/tiempos\/(\d+)$/);
  if (tiempo && (metodo === 'PATCH' || metodo === 'DELETE')) {
    const t = await env.DB.prepare('SELECT * FROM tiempos WHERE id = ?').bind(+tiempo[1]).first();
    // El Equipo solo toca lo suyo. Si no es suyo, para él no existe.
    if (!t || (!esResp && t.persona_id !== yo.id)) fallo(404, 'Ese tiempo no existe.');
    await comprobarMes(env, yo, t.inicio);
    if (metodo === 'DELETE') {
      await env.DB.prepare('DELETE FROM tiempos WHERE id = ?').bind(t.id).run();
      return json({ ok: true });
    }
    const inicio = cuerpo.inicio != null ? Number(cuerpo.inicio) : t.inicio;
    const fin = cuerpo.fin != null ? Number(cuerpo.fin) : t.fin;
    if (fin != null && fin <= inicio) fallo(400, 'Revisa las horas: el final tiene que ir después del inicio.');
    if (fin != null && fin - inicio > 24 * 3600 * 1000) fallo(400, 'Un tiempo no puede durar más de 24 horas.');
    await comprobarMes(env, yo, inicio);
    await env.DB.prepare('UPDATE tiempos SET inicio = ?, fin = ?, descripcion = ?, proyecto_id = ? WHERE id = ?').bind(
      inicio,
      fin,
      cuerpo.descripcion != null ? texto(cuerpo.descripcion, 300) : t.descripcion,
      cuerpo.proyecto_id !== undefined ? await comprobarProyecto(env, cuerpo.proyecto_id) : t.proyecto_id,
      t.id
    ).run();
    return json({ ok: true });
  }

  // Meses cerrados: todo el mundo los ve (para avisar), solo la Responsable los cambia
  if (ruta === '/meses' && metodo === 'GET') {
    const r = await env.DB.prepare('SELECT mes FROM meses_cerrados WHERE cerrado = 1 ORDER BY mes DESC').all();
    return json({ cerrados: r.results.map((x) => x.mes) });
  }
  if (ruta === '/meses' && metodo === 'POST') {
    soloResp();
    const mes = texto(cuerpo.mes, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) fallo(400, 'Elige un mes.');
    await env.DB.prepare('INSERT OR REPLACE INTO meses_cerrados (mes, cerrado) VALUES (?, ?)').bind(mes, cuerpo.cerrado ? 1 : 0).run();
    return json({ ok: true });
  }

  // Equipo
  if (ruta === '/equipo' && metodo === 'GET') {
    soloResp();
    const personas = await env.DB.prepare('SELECT id, email, nombre, rol, activa, creada FROM personas ORDER BY rol DESC, nombre COLLATE NOCASE').all();
    const invs = await env.DB.prepare('SELECT token, email, creada FROM invitaciones WHERE usada IS NULL ORDER BY creada DESC').all();
    return json({ personas: personas.results, invitaciones: invs.results });
  }
  if (ruta === '/invitaciones' && metodo === 'POST') {
    soloResp();
    const email = validarEmail(cuerpo.email);
    const existe = await env.DB.prepare('SELECT id FROM personas WHERE email = ?').bind(email).first();
    if (existe) fallo(409, 'Esa persona ya está en el equipo.');
    await env.DB.prepare('DELETE FROM invitaciones WHERE email = ? AND usada IS NULL').bind(email).run();
    const token = aleatorio(18);
    await env.DB.prepare('INSERT INTO invitaciones (token, email, creada) VALUES (?, ?, ?)').bind(token, email, Date.now()).run();
    return json({ token });
  }
  const borrarInv = ruta.match(/^\/invitaciones\/([\w-]+)$/);
  if (borrarInv && metodo === 'DELETE') {
    soloResp();
    await env.DB.prepare('DELETE FROM invitaciones WHERE token = ? AND usada IS NULL').bind(borrarInv[1]).run();
    return json({ ok: true });
  }
  const persona = ruta.match(/^\/equipo\/(\d+)$/);
  if (persona && metodo === 'PATCH') {
    soloResp();
    const p = await env.DB.prepare('SELECT * FROM personas WHERE id = ?').bind(+persona[1]).first();
    if (!p) fallo(404, 'Esa persona no existe.');
    if (p.id === yo.id && cuerpo.activa === false) fallo(400, 'No puedes quitarte el acceso a ti misma.');
    if (cuerpo.activa != null) {
      await env.DB.prepare('UPDATE personas SET activa = ? WHERE id = ?').bind(cuerpo.activa ? 1 : 0, p.id).run();
      if (!cuerpo.activa) await env.DB.prepare('DELETE FROM sesiones WHERE persona_id = ?').bind(p.id).run();
    }
    if (cuerpo.nombre) await env.DB.prepare('UPDATE personas SET nombre = ? WHERE id = ?').bind(texto(cuerpo.nombre, 80), p.id).run();
    if (cuerpo.nuevaClave) {
      const sal = nuevaSal();
      await env.DB.prepare('UPDATE personas SET clave_hash = ?, sal = ? WHERE id = ?')
        .bind(await hashClave(validarClave(cuerpo.nuevaClave), sal), sal, p.id).run();
      await env.DB.prepare('DELETE FROM sesiones WHERE persona_id = ?').bind(p.id).run();
    }
    return json({ ok: true });
  }

  // Informe: solo la Responsable. Devuelve las filas y la página hace los totales.
  if (ruta === '/informe' && metodo === 'GET') {
    soloResp();
    const desde = Number(url.searchParams.get('desde')) || 0;
    const hasta = Number(url.searchParams.get('hasta')) || 8.64e15;
    const r = await env.DB.prepare(
      `SELECT t.id, t.inicio, t.fin, t.descripcion, t.persona_id, p.nombre persona,
              t.proyecto_id, pr.nombre proyecto, c.id cliente_id, c.nombre cliente, c.color
       FROM tiempos t
       JOIN personas p ON p.id = t.persona_id
       LEFT JOIN proyectos pr ON pr.id = t.proyecto_id
       LEFT JOIN clientes c ON c.id = pr.cliente_id
       WHERE t.inicio >= ? AND t.inicio < ? AND t.fin IS NOT NULL
       ORDER BY t.inicio`
    ).bind(desde, hasta).all();
    return json({ filas: r.results });
  }

  fallo(404, 'No encuentro eso.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await manejarApi(req, env, url);
      } catch (e) {
        if (e instanceof ErrorApi) return json({ error: e.message }, e.estado);
        console.error(e);
        return json({ error: 'Algo ha fallado. Vuelve a intentarlo en un momento.' }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
