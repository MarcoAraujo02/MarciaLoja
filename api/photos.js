// API das fotos do carrossel — SL decorações (Blob Store PRIVADO)
//
// GET    /api/photos                         -> lista as fotos do carrossel (público)
// GET    /api/photos?img=galeria/x.jpg       -> entrega uma foto enviada (público)
// POST   /api/photos                         -> envia foto (exige senha)
// DELETE /api/photos?pathname=...            -> tira a foto do carrossel (exige senha)
//
// O carrossel mistura dois tipos de foto:
//   - originais: arquivos da pasta img/ do site (lista FIXAS abaixo).
//     Não dá para apagar arquivo do site pela API, então "tirar" uma original
//     grava uma marquinha em ocultas/ no Blob e ela deixa de aparecer.
//   - enviadas: fotos que a dona da loja manda pelo admin, guardadas em galeria/ no Blob.
//
// Variáveis de ambiente na Vercel:
//   ADMIN_PASSWORD -> senha da dona da loja (você cria)
//   BLOB_STORE_ID  -> criada sozinha ao conectar o Blob Store ao projeto

import { put, list, del, get } from '@vercel/blob';
import { timingSafeEqual, randomUUID } from 'node:crypto';

const ACCESS = 'private';
const PREFIX = 'galeria/';
const PREFIX_OCULTAS = 'ocultas/';
const NOME_VALIDO = /^galeria\/[0-9]+-[0-9a-f]{8}\.(jpg|png|webp)$/;
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB por foto (o admin já comprime antes de enviar)
const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// fotos originais do carrossel, na ordem em que aparecem
const FIXAS = [
  'img/tardezinha.jpeg', 'img/plantas.jpeg', 'img/sucos.jpeg', 'img/prata.jpeg',
  'img/copos2.jpeg', 'img/cafeclick.jpeg', 'img/petalas.jpeg', 'img/jardim.jpeg',
  'img/copo.jpeg', 'img/bolo.jpeg', 'img/xicaras4.jpeg',
];

function autorizado(req) {
  const enviada = String(req.headers['x-admin-password'] || '');
  const correta = process.env.ADMIN_PASSWORD || '';
  if (!correta || !enviada) return false;
  const a = Buffer.from(enviada);
  const b = Buffer.from(correta);
  return a.length === b.length && timingSafeEqual(a, b);
}

const linkDaFoto = pathname => '/api/photos?img=' + encodeURIComponent(pathname);
const marcaOculta = fixa => PREFIX_OCULTAS + fixa.replace(/^img\//, '') + '.txt';

async function listarTudo(prefix) {
  const itens = [];
  let cursor;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    itens.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return itens;
}

async function listarFotos() {
  const [enviadas, ocultas] = await Promise.all([listarTudo(PREFIX), listarTudo(PREFIX_OCULTAS)]);
  const escondidas = new Set(ocultas.map(o => o.pathname));

  enviadas.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)); // mais novas primeiro
  const novas = enviadas.map(f => ({
    url: linkDaFoto(f.pathname), pathname: f.pathname, uploadedAt: f.uploadedAt, original: false,
  }));
  const originais = FIXAS
    .filter(p => !escondidas.has(marcaOculta(p)))
    .map(p => ({ url: '/' + p, pathname: p, uploadedAt: null, original: true }));

  return [...novas, ...originais];
}

async function entregarImagem(pathname, res) {
  if (!NOME_VALIDO.test(pathname)) return res.status(400).json({ erro: 'Foto inválida' });
  const r = await get(pathname, { access: ACCESS });
  if (!r || r.statusCode !== 200) return res.status(404).json({ erro: 'Foto não encontrada' });
  const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
  res.setHeader('Content-Type', r.blob.contentType || 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // o nome de cada foto é único e nunca muda: pode guardar em cache por 1 ano
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.status(200).send(buf);
}

export default async function handler(req, res) {
  try {
    // ---------- público ----------
    if (req.method === 'GET') {
      if (req.query.img) return await entregarImagem(String(req.query.img), res);

      const fotos = await listarFotos();
      // cache de 60s na CDN da Vercel: o site fica rápido e não gasta cota do Blob a cada visita
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      return res.status(200).json(fotos);
    }

    // ---------- daqui pra baixo só com senha ----------
    if (!autorizado(req)) {
      return res.status(401).json({ erro: 'Senha incorreta' });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.check) return res.status(200).json({ ok: true }); // teste de login

      const ext = TIPOS[body.contentType];
      if (!ext || typeof body.data !== 'string') {
        return res.status(400).json({ erro: 'Envie uma imagem JPG, PNG ou WEBP' });
      }
      const buf = Buffer.from(body.data, 'base64');
      if (!buf.length) return res.status(400).json({ erro: 'Imagem vazia' });
      if (buf.length > MAX_BYTES) return res.status(413).json({ erro: 'Imagem grande demais (máx. 3 MB)' });

      const nome = `${PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
      const blob = await put(nome, buf, {
        access: ACCESS,
        contentType: body.contentType,
        addRandomSuffix: false,
      });
      return res.status(201).json({ url: linkDaFoto(blob.pathname), pathname: blob.pathname });
    }

    if (req.method === 'DELETE') {
      const pathname = String(req.query.pathname || '');

      if (FIXAS.includes(pathname)) {
        // foto original: só esconde do carrossel
        await put(marcaOculta(pathname), 'oculta', {
          access: ACCESS,
          contentType: 'text/plain',
          addRandomSuffix: false,
          allowOverwrite: true,
        });
        return res.status(200).json({ ok: true });
      }

      if (!NOME_VALIDO.test(pathname)) return res.status(400).json({ erro: 'Foto inválida' });
      await del(pathname);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ erro: 'Método não permitido' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro no servidor' });
  }
}
