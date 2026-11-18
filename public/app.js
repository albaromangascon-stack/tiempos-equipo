'use strict';

// ---------- estado ----------
const S = {
  estado: null,        // { configurado, espacio, persona }
  clientes: [],
  proyectos: [],
  cerrados: [],
  crono: null,         // tiempo en marcha
  semana: 0,           // 0 = esta semana, -1 = la anterior…
  tic: null,
  informe: { periodo: 'mes', desde: '', hasta: '', persona: '', cliente: '', proyecto: '' },
};
const $app = document.getElementById('app');

// ---------- utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(ruta, { metodo = 'GET', datos } = {}) {
  const r = await fetch('/api' + ruta, {
    method: metodo,
    headers: datos ? { 'content-type': 'application/json' } : {},
    body: datos ? JSON.stringify(datos) : undefined,
    credentials: 'same-origin',
  });
  let cuerpo = {};
  try { cuerpo = await r.json(); } catch {}
  if (!r.ok) {
    if (r.status === 401 && S.estado && S.estado.persona) { S.estado.persona = null; pintar(); }
    throw new Error(cuerpo.error || 'Algo ha fallado.');
  }
  return cuerpo;
}

function aviso(texto) {
  const a = document.getElementById('aviso');
  a.textContent = texto;
  a.classList.add('visible');
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => a.classList.remove('visible'), 2600);
}

// Duraciones siempre en h:mm
function hmm(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}
function hmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
// «1:30», «1h30», «90» (minutos), «1,5» (horas)
function leerDuracion(txt) {
  const t = String(txt || '').trim().toLowerCase().replace(/\s/g, '');
  if (!t) return 0;
  let m = t.match(/^(\d+):(\d{1,2})$/) || t.match(/^(\d+)h(\d{1,2})?m?$/);
  if (m) return (+m[1] * 60 + +(m[2] || 0)) * 60000;
  m = t.match(/^(\d+)[.,](\d+)h?$/);
  if (m) return Math.round(parseFloat(m[1] + '.' + m[2]) * 60) * 60000;
  m = t.match(/^(\d+)(min|m)?$/);
  if (m) return +m[1] * 60000;
  return NaN;
}
const dosD = (n) => String(n).padStart(2, '0');
const fechaInput = (d) => `${d.getFullYear()}-${dosD(d.getMonth() + 1)}-${dosD(d.getDate())}`;
const horaInput = (d) => `${dosD(d.getHours())}:${dosD(d.getMinutes())}`;
const mesDe = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${dosD(d.getMonth() + 1)}`; };
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const nombreDia = (d) => `${DIAS[d.getDay()]} ${d.getDate()} de ${MESES[d.getMonth()]}`;
const nombreMes = (mes) => { const [a, m] = mes.split('-'); return `${MESES[+m - 1]} de ${a}`; };
const corto = (d) => `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)}`;

function lunes(offsetSemanas = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offsetSemanas * 7);
  return d;
}

const esResp = () => S.estado?.persona?.rol === 'responsable';
const proyecto = (id) => S.proyectos.find((p) => p.id === id);
const cliente = (id) => S.clientes.find((c) => c.id === id);
const cerrado = (ms) => S.cerrados.includes(mesDe(ms));
const bloqueado = (ms) => !esResp() && cerrado(ms);

function etiquetaProyecto(id) {
  const p = proyecto(id);
  if (!p) return '<span class="etiqueta">Sin proyecto</span>';
  const c = cliente(p.cliente_id);
  return `<span class="etiqueta"><span class="punto" style="background:${esc(c?.color || '#999')}"></span>${esc(p.nombre)}${c ? ' · ' + esc(c.nombre) : ''}</span>`;
}

function opcionesProyecto(sel, { vacio = 'Sin proyecto' } = {}) {
  const activos = S.clientes.filter((c) => !c.archivado);
  let html = `<option value="">${esc(vacio)}</option>`;
  for (const c of activos) {
    const ps = S.proyectos.filter((p) => p.cliente_id === c.id && (!p.archivado || p.id === sel));
    if (!ps.length) continue;
    html += `<optgroup label="${esc(c.nombre)}">` + ps.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('') + '</optgroup>';
  }
  // Si el proyecto elegido es de un cliente archivado, que siga apareciendo
  const p = sel && proyecto(sel);
  if (p && !activos.some((c) => c.id === p.cliente_id)) html += `<option value="${p.id}" selected>${esc(p.nombre)}</option>`;
  return html;
}

const LOGO = `<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="17" r="12" fill="#507479"/><path d="M16 10v7l4 3" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/><rect x="13" y="2" width="6" height="3" rx="1.5" fill="#AB8A4D"/></svg>`;

// ---------- arranque ----------
async function cargarEstado() {
  S.estado = await api('/estado');
  if (S.estado.persona) await cargarDatos();
}
async function cargarDatos() {
  const [cat, meses, crono] = await Promise.all([api('/catalogo'), api('/meses'), api('/cronometro')]);
  S.clientes = cat.clientes;
  S.proyectos = cat.proyectos;
  S.cerrados = meses.cerrados;
  S.crono = crono.enMarcha;
}

window.addEventListener('hashchange', pintar);
(async () => {
  try { await cargarEstado(); } catch (e) { $app.innerHTML = `<p class="cargando">${esc(e.message)}</p>`; return; }
  pintar();
})();

function ruta() {
  return (location.hash.replace(/^#\/?/, '') || '').split('/');
}

function pintar() {
  clearInterval(S.tic);
  const [seccion, extra] = ruta();
  if (seccion === 'invitacion' && extra && !S.estado.persona) return pantallaUnirse(extra);
  if (!S.estado.configurado) return pantallaConfigurar();
  if (!S.estado.persona) return pantallaEntrar();
  pantallaApp(seccion || 'tiempos');
}

// ---------- acceso ----------
function cajaAcceso(titulo, intro, campos, boton, alEnviar, pie = '') {
  $app.innerHTML = `
    <div class="acceso"><div class="caja">
      <div class="logo">${LOGO}<strong>${esc(S.estado.espacio || 'Tiempos del equipo')}</strong></div>
      <h1>${titulo}</h1>
      <p class="suave">${intro}</p>
      <form novalidate>${campos}<p class="error" id="err"></p><button type="submit">${boton}</button></form>
      ${pie}
    </div></div>`;
  const f = $app.querySelector('form');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const b = f.querySelector('button[type=submit]');
    b.disabled = true;
    try {
      await alEnviar(Object.fromEntries(new FormData(f)));
    } catch (e) {
      f.querySelector('#err').textContent = e.message;
      b.disabled = false;
    }
  });
  f.querySelector('input')?.focus();
}

function pantallaConfigurar() {
  cajaAcceso(
    'Vamos a empezar',
    'Crea tu espacio. Tú serás la Responsable: después podrás invitar a tu equipo.',
    `<div class="campo"><label for="espacio">Nombre de tu negocio o equipo</label><input id="espacio" name="espacio" placeholder="Por ejemplo, Estudio Laura" required></div>
     <div class="campo"><label for="nombre">Tu nombre</label><input id="nombre" name="nombre" autocomplete="name" required></div>
     <div class="campo"><label for="email">Tu email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
     <div class="campo"><label for="clave">Contraseña (mínimo 8 caracteres)</label><input id="clave" name="clave" type="password" autocomplete="new-password" required></div>`,
    'Crear mi espacio',
    async (d) => {
      await api('/configurar', { metodo: 'POST', datos: d });
      await cargarEstado();
      location.hash = '#/clientes';
      pintar();
      aviso('¡Listo! Empieza creando tus clientes y proyectos.');
    }
  );
}

function pantallaEntrar() {
  cajaAcceso(
    'Hola de nuevo',
    'Entra con tu email y tu contraseña.',
    `<div class="campo"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required></div>
     <div class="campo"><label for="clave">Contraseña</label><input id="clave" name="clave" type="password" autocomplete="current-password" required></div>`,
    'Entrar',
    async (d) => {
      await api('/entrar', { metodo: 'POST', datos: d });
      await cargarEstado();
      if (ruta()[0] === 'invitacion') location.hash = '#/tiempos';
      pintar();
    },
    '<p class="suave" style="margin-top:14px">¿Has olvidado la contraseña? Pide a la Responsable que te ponga una nueva.</p>'
  );
}

async function pantallaUnirse(token) {
  let inv;
  try { inv = await api('/invitacion/' + encodeURIComponent(token)); } catch (e) {
    $app.innerHTML = `<div class="acceso"><div class="caja"><div class="logo">${LOGO}<strong>Tiempos del equipo</strong></div><h1>Vaya</h1><p>${esc(e.message)}</p><a href="#/">Ir a la entrada</a></div></div>`;
    return;
  }
  S.estado.espacio = inv.espacio;
  cajaAcceso(
    'Te han invitado',
    `Vas a entrar en <strong>${esc(inv.espacio)}</strong> con el email <strong>${esc(inv.email)}</strong>.`,
    `<div class="campo"><label for="nombre">Tu nombre</label><input id="nombre" name="nombre" autocomplete="name" required></div>
     <div class="campo"><label for="clave">Elige una contraseña (mínimo 8 caracteres)</label><input id="clave" name="clave" type="password" autocomplete="new-password" required></div>`,
    'Entrar al equipo',
    async (d) => {
      await api('/unirse', { metodo: 'POST', datos: { ...d, token } });
      await cargarEstado();
      location.hash = '#/tiempos';
      pintar();
      aviso('¡Bienvenida al equipo!');
    }
  );
}

// ---------- app ----------
function pantallaApp(seccion) {
  const menu = [['tiempos', 'Mis tiempos'], ['clientes', 'Clientes']];
  if (esResp()) menu.push(['equipo', 'Equipo'], ['informes', 'Informes']);
  menu.push(['cuenta', 'Cuenta']);
  if (!menu.some(([k]) => k === seccion)) seccion = 'tiempos';

  $app.innerHTML = `
    <header class="cabecera"><div class="dentro">
      <div class="logo">${LOGO}<strong>${esc(S.estado.espacio)}</strong></div>
      <nav class="menu">${menu.map(([k, n]) => `<a href="#/${k}" class="${k === seccion ? 'activo' : ''}">${n}</a>`).join('')}</nav>
    </div></header>
    <main>
      <section class="tarjeta" id="crono"></section>
      <div id="seccion"></div>
    </main>`;
  pintarCrono();
  ({ tiempos: secTiempos, clientes: secClientes, equipo: secEquipo, informes: secInformes, cuenta: secCuenta })[seccion]();
}

// ---------- cronómetro ----------
function pintarCrono() {
  const el = document.getElementById('crono');
  const t = S.crono;
  const marcha = !!t;
  el.innerHTML = `
    <form class="crono ${marcha ? 'en-marcha' : ''}">
      <input class="desc-crono" name="descripcion" placeholder="¿En qué estás trabajando?" value="${esc(t?.descripcion || '')}" aria-label="¿En qué estás trabajando?">
      <select name="proyecto_id" aria-label="Proyecto">${opcionesProyecto(t?.proyecto_id ?? null, { vacio: 'Elige proyecto' })}</select>
      <span class="reloj" id="reloj">${marcha ? hmmss(Date.now() - t.inicio) : '0:00:00'}</span>
      <button type="submit" class="${marcha ? 'parar' : 'empezar'}">${marcha ? 'Parar' : 'Empezar'}</button>
    </form>
    ${!S.proyectos.some((p) => !p.archivado) ? `<p class="suave" style="margin:10px 0 0">${esResp() ? 'Aún no hay proyectos. <a href="#/clientes">Crea tu primer cliente y proyecto</a>.' : 'Aún no hay proyectos. La Responsable tiene que crearlos.'}</p>` : ''}`;
  const f = el.querySelector('form');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    const datos = { descripcion: d.descripcion, proyecto_id: d.proyecto_id ? +d.proyecto_id : null };
    f.querySelector('button').disabled = true;
    try {
      if (S.crono) {
        await api('/cronometro/parar', { metodo: 'POST', datos });
        S.crono = null;
        aviso('Tiempo guardado.');
        if (ruta()[0] === 'tiempos' || !ruta()[0]) return pintar();
      } else {
        const r = await api('/cronometro/empezar', { metodo: 'POST', datos });
        S.crono = { id: r.id, inicio: r.inicio, ...datos };
      }
    } catch (e) { aviso(e.message); }
    pintarCrono();
  });
  clearInterval(S.tic);
  if (marcha) {
    const reloj = el.querySelector('#reloj');
    S.tic = setInterval(() => { reloj.textContent = hmmss(Date.now() - S.crono.inicio); }, 1000);
    document.title = `⏱ ${t.descripcion || 'En marcha'} · Tiempos`;
  } else {
    document.title = 'Tiempos del equipo';
  }
}

// ---------- Mis tiempos ----------
async function secTiempos() {
  const cont = document.getElementById('seccion');
  const desde = lunes(S.semana);
  const hasta = new Date(desde); hasta.setDate(hasta.getDate() + 7);
  cont.innerHTML = '<div class="tarjeta"><p class="suave">Cargando…</p></div>';
  let tiempos = [];
  try { tiempos = (await api(`/tiempos?desde=${+desde}&hasta=${+hasta}`)).tiempos; } catch (e) { cont.innerHTML = `<div class="tarjeta error">${esc(e.message)}</div>`; return; }
  const total = tiempos.reduce((a, t) => a + (t.fin - t.inicio), 0);
  const domingo = new Date(hasta); domingo.setDate(domingo.getDate() - 1);
  const porDia = new Map();
  for (const t of tiempos) {
    const k = fechaInput(new Date(t.inicio));
    if (!porDia.has(k)) porDia.set(k, []);
    porDia.get(k).push(t);
  }
  const mesesSemana = [...new Set([mesDe(+desde), mesDe(+domingo)])];
  const cerradosAqui = mesesSemana.filter((m) => S.cerrados.includes(m));

  cont.innerHTML = `
    <div class="tarjeta">
      <div class="semana">
        <div class="nav">
          <button class="icono" data-sem="-1" aria-label="Semana anterior">◀</button>
          <h2 style="margin:0">${S.semana === 0 ? 'Esta semana' : S.semana === -1 ? 'La semana pasada' : `Semana del ${corto(desde)}`}</h2>
          <button class="icono" data-sem="1" aria-label="Semana siguiente" ${S.semana >= 0 ? 'disabled' : ''}>▶</button>
        </div>
        <div class="acciones">
          <span class="total">Total: ${hmm(total)}</span>
          <button class="sec" id="anadir">+ Añadir a mano</button>
        </div>
      </div>
      <p class="suave" style="margin:0 0 10px">${corto(desde)} – ${corto(domingo)}</p>
      ${cerradosAqui.length && !esResp() ? `<div class="cerrado-aviso">🔒 ${cerradosAqui.map(nombreMes).join(' y ')} ${cerradosAqui.length > 1 ? 'están cerrados' : 'está cerrado'}. Los tiempos de ese mes ya no se pueden cambiar. Si hay que corregir algo, díselo a la Responsable.</div>` : ''}
      ${!tiempos.length ? '<div class="vacio">Aún no hay tiempos esta semana. Dale a Empezar arriba o añade uno a mano.</div>' : ''}
      ${[...porDia.entries()].map(([dia, lista]) => `
        <div class="dia">
          <div class="dia-cab"><span>${nombreDia(new Date(lista[0].inicio)).replace(/^./, (c) => c.toUpperCase())}</span><span>${hmm(lista.reduce((a, t) => a + t.fin - t.inicio, 0))}</span></div>
          ${lista.map((t) => `
            <div class="entrada">
              <div class="desc"><div>${esc(t.descripcion) || '<span class="suave">Sin descripción</span>'}</div>${etiquetaProyecto(t.proyecto_id)}</div>
              <span class="horas">${horaInput(new Date(t.inicio))}–${horaInput(new Date(t.fin))}</span>
              <span class="dur">${hmm(t.fin - t.inicio)}</span>
              <span>${bloqueado(t.inicio) ? '<span title="Mes cerrado" aria-label="Mes cerrado">🔒</span>' : `<button class="icono" data-editar="${t.id}" aria-label="Editar">✎</button><button class="icono" data-borrar="${t.id}" aria-label="Borrar">🗑</button>`}</span>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;

  cont.querySelectorAll('[data-sem]').forEach((b) => b.addEventListener('click', () => { S.semana += +b.dataset.sem; secTiempos(); }));
  cont.querySelector('#anadir').addEventListener('click', () => ventanaTiempo(null));
  cont.querySelectorAll('[data-editar]').forEach((b) => b.addEventListener('click', () => ventanaTiempo(tiempos.find((t) => t.id === +b.dataset.editar))));
  cont.querySelectorAll('[data-borrar]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('¿Borrar este tiempo?')) return;
    try { await api('/tiempos/' + b.dataset.borrar, { metodo: 'DELETE' }); aviso('Borrado.'); secTiempos(); } catch (e) { aviso(e.message); }
  }));
}

function ventana(html, alEnviar) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form novalidate>${html}<p class="error" id="err"></p><div class="botones"><button type="button" class="sec" data-cerrar>Cancelar</button><button type="submit">Guardar</button></div></form>`;
  document.body.appendChild(d);
  d.querySelector('[data-cerrar]').addEventListener('click', () => d.close());
  d.addEventListener('close', () => d.remove());
  const f = d.querySelector('form');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await alEnviar(Object.fromEntries(new FormData(f)), f); d.close(); } catch (e) { f.querySelector('#err').textContent = e.message; }
  });
  d.showModal();
  return d;
}

function ventanaTiempo(t) {
  const ini = t ? new Date(t.inicio) : null;
  const fin = t ? new Date(t.fin) : null;
  ventana(`
    <h2>${t ? 'Editar tiempo' : 'Añadir tiempo a mano'}</h2>
    <div class="campo"><label for="v-desc">¿Qué hiciste?</label><input id="v-desc" name="descripcion" value="${esc(t?.descripcion || '')}"></div>
    <div class="campo"><label for="v-proy">Proyecto</label><select id="v-proy" name="proyecto_id">${opcionesProyecto(t?.proyecto_id ?? null)}</select></div>
    <div class="campo"><label for="v-fecha">Fecha</label><input id="v-fecha" type="date" name="fecha" value="${fechaInput(ini || new Date())}" required></div>
    <div class="fila">
      <div class="campo"><label for="v-ini">Empieza</label><input id="v-ini" type="time" name="inicio" value="${ini ? horaInput(ini) : ''}"></div>
      <div class="campo"><label for="v-fin">Acaba</label><input id="v-fin" type="time" name="fin" value="${fin ? horaInput(fin) : ''}"></div>
    </div>
    <div class="campo"><label for="v-dur">O solo la duración (por ejemplo, 1:30)</label><input id="v-dur" name="duracion" inputmode="numeric" placeholder="h:mm"></div>`,
    async (d) => {
      if (!d.fecha) throw new Error('Elige la fecha.');
      const [a, m, dd] = d.fecha.split('-').map(Number);
      const aHora = (hhmm) => { const [h, mi] = hhmm.split(':').map(Number); return +new Date(a, m - 1, dd, h, mi); };
      let inicio, fin2;
      const dur = leerDuracion(d.duracion);
      if (Number.isNaN(dur)) throw new Error('No entiendo esa duración. Escríbela así: 1:30.');
      if (d.inicio && d.fin) {
        inicio = aHora(d.inicio); fin2 = aHora(d.fin);
        if (fin2 <= inicio) fin2 += 24 * 3600 * 1000; // pasa de medianoche
      } else if (dur) {
        inicio = aHora(d.inicio || '09:00'); fin2 = inicio + dur;
      } else {
        throw new Error('Pon la hora de empezar y de acabar, o solo la duración.');
      }
      const datos = { descripcion: d.descripcion, proyecto_id: d.proyecto_id ? +d.proyecto_id : null, inicio, fin: fin2 };
      if (t) await api('/tiempos/' + t.id, { metodo: 'PATCH', datos });
      else await api('/tiempos', { metodo: 'POST', datos });
      aviso('Guardado.');
      secTiempos();
    }
  );
}

// ---------- Clientes ----------
let verArchivados = false;
function secClientes() {
  const cont = document.getElementById('seccion');
  const r = esResp();
  const clientes = S.clientes.filter((c) => verArchivados || !c.archivado);
  cont.innerHTML = `
    <div class="tarjeta">
      <div class="semana"><h2 style="margin:0">Clientes y proyectos</h2>
        <div class="acciones">
          <label style="display:flex;align-items:center;gap:6px;margin:0"><input type="checkbox" id="arch" ${verArchivados ? 'checked' : ''} style="width:auto;min-height:0"> Ver archivados</label>
          ${r ? '<button id="nuevo-cliente">+ Nuevo cliente</button>' : ''}
        </div>
      </div>
      ${!r ? '<p class="suave">Los clientes y proyectos los crea la Responsable.</p>' : ''}
      ${!clientes.length ? `<div class="vacio">${r ? 'Aún no tienes clientes. Crea el primero y añádele sus proyectos.' : 'Aún no hay clientes.'}</div>` : ''}
      ${clientes.map((c) => `
        <div class="cliente ${c.archivado ? 'archivado' : ''}">
          <div class="cliente-cab">
            <span class="punto" style="background:${esc(c.color)};width:14px;height:14px"></span>
            <h3>${esc(c.nombre)}${c.archivado ? ' <span class="suave">(archivado)</span>' : ''}</h3>
            ${r ? `<button class="icono" data-ec="${c.id}" aria-label="Editar cliente">✎</button>
                   <button class="mini sec" data-ac="${c.id}">${c.archivado ? 'Recuperar' : 'Archivar'}</button>` : ''}
          </div>
          <ul class="proyectos">
            ${S.proyectos.filter((p) => p.cliente_id === c.id && (verArchivados || !p.archivado)).map((p) => `
              <li class="${p.archivado ? 'archivado' : ''}"><span>${esc(p.nombre)}${p.archivado ? ' <span class="suave">(archivado)</span>' : ''}</span>
              ${r ? `<button class="icono" data-ep="${p.id}" aria-label="Editar proyecto">✎</button><button class="mini sec" data-ap="${p.id}">${p.archivado ? 'Recuperar' : 'Archivar'}</button>` : ''}</li>`).join('')}
          </ul>
          ${r && !c.archivado ? `<button class="mini sec" data-np="${c.id}" style="margin-top:6px">+ Proyecto</button>` : ''}
        </div>`).join('')}
    </div>`;

  cont.querySelector('#arch').addEventListener('change', (e) => { verArchivados = e.target.checked; secClientes(); });
  if (!r) return;
  const recargar = async () => { const cat = await api('/catalogo'); S.clientes = cat.clientes; S.proyectos = cat.proyectos; secClientes(); pintarCrono(); };
  const formCliente = (c) => ventana(`
      <h2>${c ? 'Editar cliente' : 'Nuevo cliente'}</h2>
      <div class="fila"><div class="campo"><label for="c-nom">Nombre</label><input id="c-nom" name="nombre" value="${esc(c?.nombre || '')}" required></div>
      <div class="campo fijo"><label for="c-col">Color</label><input id="c-col" type="color" name="color" value="${esc(c?.color || colorSiguiente())}"></div></div>`,
    async (d) => {
      if (c) await api('/clientes/' + c.id, { metodo: 'PATCH', datos: d });
      else await api('/clientes', { metodo: 'POST', datos: d });
      await recargar();
    });
  const formProyecto = (clienteId, p) => ventana(`
      <h2>${p ? 'Editar proyecto' : 'Nuevo proyecto'}</h2>
      <div class="campo"><label for="p-nom">Nombre del proyecto</label><input id="p-nom" name="nombre" value="${esc(p?.nombre || '')}" required></div>
      <div class="campo"><label for="p-cli">Cliente</label><select id="p-cli" name="cliente_id">${S.clientes.filter((c) => !c.archivado || c.id === clienteId).map((c) => `<option value="${c.id}" ${c.id === clienteId ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select></div>`,
    async (d) => {
      const datos = { nombre: d.nombre, cliente_id: +d.cliente_id };
      if (p) await api('/proyectos/' + p.id, { metodo: 'PATCH', datos });
      else await api('/proyectos', { metodo: 'POST', datos });
      await recargar();
    });

  cont.querySelector('#nuevo-cliente').addEventListener('click', () => formCliente(null));
  cont.querySelectorAll('[data-ec]').forEach((b) => b.addEventListener('click', () => formCliente(cliente(+b.dataset.ec))));
  cont.querySelectorAll('[data-np]').forEach((b) => b.addEventListener('click', () => formProyecto(+b.dataset.np, null)));
  cont.querySelectorAll('[data-ep]').forEach((b) => b.addEventListener('click', () => { const p = proyecto(+b.dataset.ep); formProyecto(p.cliente_id, p); }));
  cont.querySelectorAll('[data-ac]').forEach((b) => b.addEventListener('click', async () => {
    const c = cliente(+b.dataset.ac);
    try { await api('/clientes/' + c.id, { metodo: 'PATCH', datos: { archivado: !c.archivado } }); await recargar(); } catch (e) { aviso(e.message); }
  }));
  cont.querySelectorAll('[data-ap]').forEach((b) => b.addEventListener('click', async () => {
    const p = proyecto(+b.dataset.ap);
    try { await api('/proyectos/' + p.id, { metodo: 'PATCH', datos: { archivado: !p.archivado } }); await recargar(); } catch (e) { aviso(e.message); }
  }));
}
const COLORES = ['#507479', '#AB8A4D', '#DF9E92', '#6B8E5A', '#7A6CA8', '#C0733F', '#3F7FA6', '#A65D7B'];
const colorSiguiente = () => COLORES[S.clientes.length % COLORES.length];

// ---------- Equipo ----------
async function secEquipo() {
  const cont = document.getElementById('seccion');
  let datos;
  try { datos = await api('/equipo'); } catch (e) { cont.innerHTML = `<div class="tarjeta error">${esc(e.message)}</div>`; return; }
  const enlace = (token) => `${location.origin}/#/invitacion/${token}`;
  const bloqueEnlace = (token, email) => `
    <div class="enlace-inv">
      <input readonly value="${esc(enlace(token))}" aria-label="Enlace de invitación para ${esc(email)}">
      <button class="mini" data-copiar="${esc(enlace(token))}">Copiar</button>
      <a class="boton mini sec" style="min-height:32px;padding:.3em .7em;font-size:.88rem" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Te invito a apuntar tus tiempos en ${S.estado.espacio}. Entra aquí y elige tu contraseña: ${enlace(token)}`)}">WhatsApp</a>
    </div>`;
  cont.innerHTML = `
    <div class="tarjeta">
      <h2>Invitar a alguien</h2>
      <p class="suave">Escribe su email y te damos un enlace para mandárselo por WhatsApp o por email. Al abrirlo, elige su contraseña y entra en tu equipo.</p>
      <form id="invitar" class="fila" novalidate>
        <div class="campo" style="margin:0"><label for="i-email">Email de la persona</label><input id="i-email" name="email" type="email" required></div>
        <button class="fijo" type="submit">Crear invitación</button>
      </form>
      <p class="error" id="err"></p>
      <div id="nuevo-enlace"></div>
    </div>
    ${datos.invitaciones.length ? `<div class="tarjeta"><h2>Invitaciones sin usar</h2>
      ${datos.invitaciones.map((i) => `<div class="persona" style="display:block"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><strong style="overflow-wrap:anywhere">${esc(i.email)}</strong><button class="mini peligro" data-anular="${esc(i.token)}">Anular</button></div>${bloqueEnlace(i.token, i.email)}</div>`).join('')}
    </div>` : ''}
    <div class="tarjeta">
      <h2>Tu equipo</h2>
      ${datos.personas.map((p) => `
        <div class="persona ${p.activa ? '' : 'archivado'}">
          <div class="quien"><div><strong>${esc(p.nombre)}</strong> <span class="rol ${p.rol === 'responsable' ? 'resp' : ''}">${p.rol === 'responsable' ? 'Responsable' : 'Equipo'}</span>${p.activa ? '' : ' <span class="suave">(sin acceso)</span>'}</div><div class="suave">${esc(p.email)}</div></div>
          <button class="mini sec" data-clave="${p.id}">Nueva contraseña</button>
          ${p.id !== S.estado.persona.id ? `<button class="mini ${p.activa ? 'peligro' : 'sec'}" data-acceso="${p.id}" data-activa="${p.activa}">${p.activa ? 'Quitar acceso' : 'Devolver acceso'}</button>` : ''}
        </div>`).join('')}
      <p class="suave" style="margin-top:12px">Si quitas el acceso a alguien, sus tiempos se quedan en los informes.</p>
    </div>`;

  const conectarCopiar = (raiz) => raiz.querySelectorAll('[data-copiar]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copiar); aviso('Enlace copiado.'); } catch { b.previousElementSibling.select(); aviso('Selecciónalo y cópialo.'); }
  }));
  conectarCopiar(cont);
  const f = cont.querySelector('#invitar');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = f.email.value;
    try {
      const r = await api('/invitaciones', { metodo: 'POST', datos: { email } });
      await secEquipo();
      const n = document.getElementById('nuevo-enlace');
      n.innerHTML = `<p style="margin-top:12px"><strong>Invitación creada.</strong> Mándale este enlace a ${esc(email)}:</p>${bloqueEnlace(r.token, email)}`;
      conectarCopiar(n);
    } catch (e) { cont.querySelector('#err').textContent = e.message; }
  });
  cont.querySelectorAll('[data-anular]').forEach((b) => b.addEventListener('click', async () => {
    await api('/invitaciones/' + encodeURIComponent(b.dataset.anular), { metodo: 'DELETE' }); aviso('Invitación anulada.'); secEquipo();
  }));
  cont.querySelectorAll('[data-acceso]').forEach((b) => b.addEventListener('click', async () => {
    const activa = b.dataset.activa === '1';
    if (activa && !confirm('¿Quitar el acceso a esta persona? Podrás devolvérselo cuando quieras.')) return;
    try { await api('/equipo/' + b.dataset.acceso, { metodo: 'PATCH', datos: { activa: !activa } }); secEquipo(); } catch (e) { aviso(e.message); }
  }));
  cont.querySelectorAll('[data-clave]').forEach((b) => b.addEventListener('click', () => {
    const p = datos.personas.find((x) => x.id === +b.dataset.clave);
    ventana(`<h2>Nueva contraseña para ${esc(p.nombre)}</h2>
      <p class="suave">Escríbela y pásasela tú. Al guardarla se cierra su sesión en todos sus dispositivos.</p>
      <div class="campo"><label for="n-clave">Contraseña nueva (mínimo 8 caracteres)</label><input id="n-clave" name="nuevaClave" type="text" autocomplete="off" required></div>`,
    async (d) => { await api('/equipo/' + p.id, { metodo: 'PATCH', datos: d }); aviso('Contraseña cambiada.'); });
  }));
}

// ---------- Informes ----------
function rangoInforme() {
  const I = S.informe;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  if (I.periodo === 'semana') { const d = lunes(0); const h = new Date(d); h.setDate(h.getDate() + 7); return [d, h]; }
  if (I.periodo === 'mes') return [new Date(hoy.getFullYear(), hoy.getMonth(), 1), new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1)];
  if (I.periodo === 'mespasado') return [new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1), new Date(hoy.getFullYear(), hoy.getMonth(), 1)];
  const d = I.desde ? new Date(I.desde + 'T00:00') : new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const h = I.hasta ? new Date(I.hasta + 'T00:00') : new Date(hoy);
  h.setDate(h.getDate() + 1);
  return [d, h];
}

async function secInformes() {
  const cont = document.getElementById('seccion');
  const I = S.informe;
  const [desde, hasta] = rangoInforme();
  let filas = [];
  try { filas = (await api(`/informe?desde=${+desde}&hasta=${+hasta}`)).filas; } catch (e) { cont.innerHTML = `<div class="tarjeta error">${esc(e.message)}</div>`; return; }

  const personas = [...new Map(filas.map((f) => [f.persona_id, f.persona])).entries()];
  const clientesInf = [...new Map(filas.filter((f) => f.cliente_id).map((f) => [f.cliente_id, f.cliente])).entries()];
  const proyectosInf = [...new Map(filas.filter((f) => f.proyecto_id).map((f) => [f.proyecto_id, f.proyecto])).entries()];
  const vis = filas.filter((f) =>
    (!I.persona || f.persona_id === +I.persona) &&
    (!I.cliente || f.cliente_id === +I.cliente) &&
    (!I.proyecto || f.proyecto_id === +I.proyecto));
  const total = vis.reduce((a, f) => a + f.fin - f.inicio, 0);
  const agrupar = (clave, nombre, color) => {
    const m = new Map();
    for (const f of vis) {
      const k = f[clave] ?? 0;
      const g = m.get(k) || { nombre: f[nombre] || 'Sin proyecto', color: color ? f.color : null, ms: 0 };
      g.ms += f.fin - f.inicio; m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.ms - a.ms);
  };
  const barras = (titulo, lista) => {
    const max = Math.max(1, ...lista.map((g) => g.ms));
    return `<div class="tarjeta" style="margin:0"><h3>${titulo}</h3>${lista.length ? lista.map((g) => `
      <div class="barra"><div class="nom"><span>${esc(g.nombre)}</span><span>${hmm(g.ms)}</span></div>
      <div class="pista"><div class="relleno" style="width:${(g.ms / max) * 100}%;${g.color ? `background:${esc(g.color)}` : ''}"></div></div></div>`).join('') : '<p class="suave">Sin datos.</p>'}</div>`;
  };
  const opciones = (lista, sel, todos) => `<option value="">${todos}</option>` + lista.map(([id, n]) => `<option value="${id}" ${String(id) === String(sel) ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const ultimo = new Date(hasta); ultimo.setDate(ultimo.getDate() - 1);
  const mesActual = mesDe(Date.now());
  const mesPasado = mesDe(+new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));

  cont.innerHTML = `
    <div class="tarjeta">
      <h2>Informes</h2>
      <form id="filtros" class="fila">
        <div class="campo"><label for="f-per">Periodo</label><select id="f-per" name="periodo">
          ${[['semana', 'Esta semana'], ['mes', 'Este mes'], ['mespasado', 'El mes pasado'], ['medida', 'Fechas a medida']].map(([k, n]) => `<option value="${k}" ${I.periodo === k ? 'selected' : ''}>${n}</option>`).join('')}
        </select></div>
        ${I.periodo === 'medida' ? `
          <div class="campo"><label for="f-des">Desde</label><input id="f-des" type="date" name="desde" value="${fechaInput(desde)}"></div>
          <div class="campo"><label for="f-has">Hasta</label><input id="f-has" type="date" name="hasta" value="${fechaInput(ultimo)}"></div>` : ''}
        <div class="campo"><label for="f-pe">Persona</label><select id="f-pe" name="persona">${opciones(personas, I.persona, 'Todo el equipo')}</select></div>
        <div class="campo"><label for="f-cl">Cliente</label><select id="f-cl" name="cliente">${opciones(clientesInf, I.cliente, 'Todos')}</select></div>
        <div class="campo"><label for="f-pr">Proyecto</label><select id="f-pr" name="proyecto">${opciones(proyectosInf, I.proyecto, 'Todos')}</select></div>
      </form>
      <p class="suave" style="margin:0">Del ${corto(desde)} al ${corto(ultimo)} de ${ultimo.getFullYear()}</p>
    </div>
    <div class="resumen">
      <div class="dato"><div class="num">${hmm(total)}</div><div class="que">horas en total</div></div>
      <div class="dato"><div class="num">${new Set(vis.map((f) => f.persona_id)).size}</div><div class="que">personas</div></div>
      <div class="dato"><div class="num">${new Set(vis.filter((f) => f.proyecto_id).map((f) => f.proyecto_id)).size}</div><div class="que">proyectos</div></div>
    </div>
    <div class="grupos">
      ${barras('Por persona', agrupar('persona_id', 'persona'))}
      ${barras('Por cliente', agrupar('cliente_id', 'cliente', true).map((g) => ({ ...g, nombre: g.nombre === 'Sin proyecto' ? 'Sin cliente' : g.nombre })))}
      ${barras('Por proyecto', agrupar('proyecto_id', 'proyecto'))}
    </div>
    <div class="tarjeta" style="margin-top:16px">
      <div class="semana"><h3 style="margin:0">Detalle (${vis.length})</h3><button class="sec" id="csv" ${vis.length ? '' : 'disabled'}>Descargar CSV</button></div>
      ${vis.length ? `<div class="tabla-scroll"><table>
        <thead><tr><th>Fecha</th><th>Persona</th><th>Cliente</th><th>Proyecto</th><th>Descripción</th><th style="text-align:right">Duración</th></tr></thead>
        <tbody>${vis.slice().reverse().map((f) => `<tr><td style="white-space:nowrap">${fechaInput(new Date(f.inicio)).split('-').reverse().join('/')}</td><td>${esc(f.persona)}</td><td>${esc(f.cliente || '—')}</td><td>${esc(f.proyecto || '—')}</td><td>${esc(f.descripcion)}</td><td class="num">${hmm(f.fin - f.inicio)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="vacio">No hay tiempos en este periodo.</div>'}
    </div>
    <div class="tarjeta">
      <h2>Cerrar un mes</h2>
      <p class="suave">Cuando ya has facturado un mes, ciérralo. Así nadie del equipo puede añadir, cambiar ni borrar tiempos de ese mes. Tú sí puedes, y puedes reabrirlo cuando quieras.</p>
      <form id="cerrar-mes" class="fila" novalidate>
        <div class="campo" style="margin:0"><label for="m-mes">Mes</label><input id="m-mes" type="month" name="mes" value="${mesPasado}" max="${mesActual}"></div>
        <button class="dorado fijo" type="submit">Cerrar el mes</button>
      </form>
      <div class="meses" style="margin-top:14px">${S.cerrados.length ? S.cerrados.map((m) => `<span class="mes">🔒 ${nombreMes(m)} <button class="mini sec" data-reabrir="${m}">Reabrir</button></span>`).join('') : '<span class="suave">No hay meses cerrados.</span>'}</div>
    </div>`;

  const f = cont.querySelector('#filtros');
  f.addEventListener('change', () => {
    const d = Object.fromEntries(new FormData(f));
    Object.assign(I, { persona: d.persona || '', cliente: d.cliente || '', proyecto: d.proyecto || '', periodo: d.periodo });
    if (d.periodo === 'medida') { I.desde = d.desde || I.desde; I.hasta = d.hasta || I.hasta; }
    secInformes();
  });
  cont.querySelector('#csv').addEventListener('click', () => descargarCsv(vis, desde, ultimo));
  const mesF = cont.querySelector('#cerrar-mes');
  mesF.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const mes = mesF.mes.value;
    if (!mes) return aviso('Elige un mes.');
    if (!confirm(`¿Cerrar ${nombreMes(mes)}? El equipo ya no podrá cambiar sus tiempos de ese mes.`)) return;
    try { await api('/meses', { metodo: 'POST', datos: { mes, cerrado: true } }); S.cerrados = (await api('/meses')).cerrados; aviso('Mes cerrado.'); secInformes(); } catch (e) { aviso(e.message); }
  });
  cont.querySelectorAll('[data-reabrir]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('/meses', { metodo: 'POST', datos: { mes: b.dataset.reabrir, cerrado: false } }); S.cerrados = (await api('/meses')).cerrados; aviso('Mes reabierto.'); secInformes(); } catch (e) { aviso(e.message); }
  }));
}

function descargarCsv(filas, desde, hasta) {
  const celda = (v) => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lineas = [['Fecha', 'Persona', 'Cliente', 'Proyecto', 'Descripción', 'Duración (h:mm)'].join(';')];
  for (const f of filas) {
    lineas.push([fechaInput(new Date(f.inicio)).split('-').reverse().join('/'), f.persona, f.cliente || '', f.proyecto || '', f.descripcion, hmm(f.fin - f.inicio)].map(celda).join(';'));
  }
  const blob = new Blob(['﻿' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tiempos_${fechaInput(desde)}_${fechaInput(hasta)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Cuenta ----------
function secCuenta() {
  const cont = document.getElementById('seccion');
  const p = S.estado.persona;
  cont.innerHTML = `
    <div class="tarjeta">
      <h2>Tu cuenta</h2>
      <p><strong>${esc(p.nombre)}</strong> · ${esc(p.email)} · <span class="rol ${p.rol === 'responsable' ? 'resp' : ''}">${p.rol === 'responsable' ? 'Responsable' : 'Equipo'}</span></p>
      <button class="sec" id="salir">Salir</button>
    </div>
    <div class="tarjeta">
      <h2>Cambiar tu contraseña</h2>
      <form id="clave" novalidate>
        <div class="fila">
          <div class="campo"><label for="k-act">Contraseña actual</label><input id="k-act" type="password" name="actual" autocomplete="current-password"></div>
          <div class="campo"><label for="k-nue">Contraseña nueva</label><input id="k-nue" type="password" name="nueva" autocomplete="new-password"></div>
        </div>
        <p class="error" id="err-clave"></p>
        <button type="submit">Cambiar contraseña</button>
      </form>
    </div>
    ${esResp() ? `<div class="tarjeta">
      <h2>Nombre del espacio</h2>
      <form id="espacio" class="fila" novalidate>
        <div class="campo" style="margin:0"><label for="e-nom">Nombre</label><input id="e-nom" name="espacio" value="${esc(S.estado.espacio)}"></div>
        <button class="fijo" type="submit">Guardar</button>
      </form>
    </div>` : ''}`;
  cont.querySelector('#salir').addEventListener('click', async () => {
    await api('/salir', { metodo: 'POST' });
    S.estado.persona = null; location.hash = '#/'; pintar();
  });
  const fc = cont.querySelector('#clave');
  fc.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('/mi-clave', { metodo: 'POST', datos: Object.fromEntries(new FormData(fc)) }); fc.reset(); fc.querySelector('#err-clave').textContent = ''; aviso('Contraseña cambiada.'); }
    catch (e) { fc.querySelector('#err-clave').textContent = e.message; }
  });
  const fe = cont.querySelector('#espacio');
  if (fe) fe.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { await api('/espacio', { metodo: 'PATCH', datos: { espacio: fe.espacio.value } }); S.estado.espacio = fe.espacio.value.trim(); pintar(); aviso('Guardado.'); } catch (e) { aviso(e.message); }
  });
}
