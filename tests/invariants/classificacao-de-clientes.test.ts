/**
 * CLASSIFICAÇÃO DO CLIENTE — o que a migration 9257 promete, no banco.
 *
 *   I1  ganhar um negócio grava `contacts.last_won_at` com o `closed_at` dele;
 *   I2  vale o ganho MAIS RECENTE entre os negócios do contato;
 *   I3  reabrir o negócio ganho RECALCULA (não fica o valor antigo);
 *   I4  trocar o contato do negócio ganho move a venda de um contato ao outro;
 *   I5  apagar o negócio ganho tira a venda;
 *   I6  sessão nenhuma grava `last_won_at` nem `pre_inativo_avisado_para`;
 *   I7  os prazos da organização têm CHECK (pré-inativo > ativo);
 *   I8  o kind `client_pre_inactive` é aceito na Central.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});

const ORG = randomUUID();
const PIPELINE = randomUUID();
const STAGE = randomUUID();

async function contato(): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Cliente')", [id, ORG]);
  return id;
}

async function negocio(contactId: string | null): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,title,contact_id) values($1,$2,$3,$4,'Negócio',$5)",
    [id, ORG, PIPELINE, STAGE, contactId],
  );
  return id;
}

async function ganhar(leadId: string, em: string): Promise<void> {
  await pool.query("update crm_leads set status='won', closed_at=$2 where id=$1", [leadId, em]);
}

async function ultimaVenda(contactId: string): Promise<string | null> {
  const r = await pool.query<{ v: Date | null }>("select last_won_at as v from contacts where id=$1", [contactId]);
  return r.rows[0]?.v ? r.rows[0].v.toISOString() : null;
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Classif','Classif')",
    [ORG],
  );
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1::uuid,$2,'Funil',$1::text)", [
    PIPELINE,
    ORG,
  ]);
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Entrada','entrada',1)",
    [STAGE, ORG, PIPELINE],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id=$1", [ORG]);
  await pool.end();
});

describe("last_won_at mantido pelo gatilho de crm_leads", () => {
  it("I1/I2 — grava o ganho mais recente", async () => {
    const c = await contato();
    const a = await negocio(c);
    const b = await negocio(c);
    expect(await ultimaVenda(c)).toBeNull();
    await ganhar(a, "2026-03-01T00:00:00.000Z");
    expect(await ultimaVenda(c)).toBe("2026-03-01T00:00:00.000Z");
    await ganhar(b, "2026-01-01T00:00:00.000Z");
    expect(await ultimaVenda(c)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("I3 — reabrir o ganho recalcula", async () => {
    const c = await contato();
    const a = await negocio(c);
    const b = await negocio(c);
    await ganhar(a, "2026-02-01T00:00:00.000Z");
    await ganhar(b, "2026-05-01T00:00:00.000Z");
    await pool.query("update crm_leads set status='open', closed_at=null where id=$1", [b]);
    expect(await ultimaVenda(c)).toBe("2026-02-01T00:00:00.000Z");
    await pool.query("update crm_leads set status='open', closed_at=null where id=$1", [a]);
    expect(await ultimaVenda(c)).toBeNull();
  });

  it("I4 — trocar o contato move a venda", async () => {
    const c1 = await contato();
    const c2 = await contato();
    const a = await negocio(c1);
    await ganhar(a, "2026-04-01T00:00:00.000Z");
    await pool.query("update crm_leads set contact_id=$2 where id=$1", [a, c2]);
    expect(await ultimaVenda(c1)).toBeNull();
    expect(await ultimaVenda(c2)).toBe("2026-04-01T00:00:00.000Z");
  });

  it("I5 — apagar o negócio ganho tira a venda", async () => {
    const c = await contato();
    const a = await negocio(c);
    await ganhar(a, "2026-04-01T00:00:00.000Z");
    await pool.query("delete from crm_leads where id=$1", [a]);
    expect(await ultimaVenda(c)).toBeNull();
  });
});

describe("guardas", () => {
  it("I6 — sessão não grava as colunas de venda", async () => {
    const c = await contato();
    for (const coluna of ["last_won_at", "pre_inativo_avisado_para"]) {
      const cx = await pool.connect();
      try {
        await cx.query("begin");
        await cx.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: randomUUID(), role: "authenticated" }),
        ]);
        await expect(cx.query(`update contacts set ${coluna}=now() where id=$1`, [c])).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await cx.query("rollback");
        cx.release();
      }
    }
    // Sem sessão (service role, cron) passa.
    await pool.query("update contacts set pre_inativo_avisado_para=now() where id=$1", [c]);
  });

  it("I7 — CHECK dos prazos", async () => {
    await expect(
      pool.query("update organizations set classificacao_ativo_dias=200, classificacao_pre_inativo_dias=100 where id=$1", [
        ORG,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("update organizations set classificacao_ativo_dias=30, classificacao_pre_inativo_dias=60 where id=$1", [
      ORG,
    ]);
    const r = await pool.query("select classificacao_ativo_dias a, classificacao_pre_inativo_dias p from organizations where id=$1", [
      ORG,
    ]);
    expect(r.rows[0]).toEqual({ a: 30, p: 60 });
  });

  it("I8 — a Central aceita client_pre_inactive", async () => {
    const c = await contato();
    await pool.query(
      "insert into agent_inbox_items(organization_id,kind,severity,title,ref_kind,ref_id) values($1,'client_pre_inactive','warn','t','contact',$2)",
      [ORG, c],
    );
  });
});
