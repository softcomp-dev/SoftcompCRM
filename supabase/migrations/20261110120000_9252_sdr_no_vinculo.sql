-- manifest: Função SDR por vínculo: user_organizations.sdr_since marca quem é SDR na organização; a função só vale com organizations.settings.sdr.enabled ligado, papel agent ou acima e vínculo ativo, regra calculada em lib/sdr/permissoes.ts.
--
-- SDR NÃO é um quinto papel. Os papéis (viewer < agent < manager < admin) são
-- uma escada de PODER, lida pela RLS e por requireRole; SDR é uma FUNÇÃO
-- comercial que se soma ao papel. Por isso a marca mora no vínculo e não na
-- coluna `role`, e nenhuma policy muda.
--
-- Por que coluna e não tabela (DIRC — "Duplicar: vive aqui mesmo?"): a marca
-- só existe enquanto o vínculo existe. Na coluna, apagar o vínculo apaga a
-- marca sem chave estrangeira a manter, e não há linha órfã possível. Quem
-- marcou e quando fica na auditoria (`sdr.assigned`), não aqui.
--
-- Nenhuma CHECK amarra a marca ao papel nem ao interruptor de propósito: um
-- rebaixamento para viewer, uma revogação ou o interruptor desligado NÃO
-- apagam a marca, só a deixam sem efeito. Quem decide se ela vale é o cálculo
-- (consistência por derivação). Assim desligar e religar a função devolve a
-- equipe como estava, e a troca de papel nunca falha por causa da marca.

alter table public.user_organizations add column if not exists sdr_since timestamptz;

comment on column public.user_organizations.sdr_since is
  'Desde quando o membro é SDR nesta organização (null = não é). Só tem efeito com organizations.settings.sdr.enabled = true, papel >= agent e vínculo ativo; regra em lib/sdr/permissoes.ts.';

-- A lista de SDRs de uma organização é a leitura quente (escolha de
-- responsável, permissões): índice parcial, só sobre quem está marcado.
create index if not exists idx_user_organizations_sdr
  on public.user_organizations (organization_id)
  where sdr_since is not null;
