"use client";
/**
 * Célula "SDR" de um membro na tabela da equipe (só aparece com a função
 * ligada). O admin marca e desmarca; o gerente só vê.
 *
 * Uma marca SEM EFEITO aparece, e diz por quê: quem foi rebaixado a
 * "Somente leitura" ou teve o acesso revogado continua marcado (a regra é
 * calculada, `lib/sdr/permissoes.ts`) — esconder a marca deixaria o admin sem
 * entender por que aquela pessoa não age como SDR.
 */
import type { TeamMember } from "@/hooks/team/useTeamMembers";
import { useT } from "@/hooks/i18n/useT";
import type { SdrAssignment } from "@/hooks/sdr/useSdr";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import type { MotivoSdrInativo } from "@/lib/sdr/permissoes";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

/** Papel que não pode ser marcado. Espelha `PAPEIS_QUE_PODEM_SER_SDR`; o servidor recusa de qualquer jeito. */
const PAPEL_SEM_SDR = "viewer";

function motivoLegivel(motivo: MotivoSdrInativo | null, t: (s: string) => string): string | null {
  switch (motivo) {
    case "role_below_minimum":
      return t("Sem efeito: o papel Somente leitura não pode ser SDR.");
    case "membership_revoked":
      return t("Sem efeito: acesso revogado.");
    default:
      return null;
  }
}

interface Props {
  member: TeamMember;
  assignment: SdrAssignment | undefined;
  canManage: boolean;
  pending: boolean;
  onChange: (assigned: boolean) => void;
}

export function SdrCell({ member, assignment, canManage, pending, onChange }: Props) {
  const t = useT();
  const marcado = !!assignment;
  const motivo = motivoLegivel(assignment?.inactive_reason ?? null, t);
  // Marcar é recusado pelo servidor para viewer e revogado; desmarcar é sempre
  // permitido (limpeza). A chave só fica travada no sentido que não existe.
  const naoPodeMarcar = member.role === PAPEL_SEM_SDR || !!member.revoked_at;

  if (canManage) {
    return (
      <div className="flex flex-col gap-1">
        <Switch
          checked={marcado}
          disabled={pending || (!marcado && naoPodeMarcar)}
          onCheckedChange={onChange}
          aria-label={`${t("SDR")}: ${rotuloDoMembro(member, t)}`}
          title={!marcado && member.role === PAPEL_SEM_SDR ? t("O papel Somente leitura não pode ser SDR.") : undefined}
        />
        {motivo ? <span className="text-xs text-muted-foreground">{motivo}</span> : null}
      </div>
    );
  }

  if (!marcado) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col gap-1">
      <Badge variant={assignment?.active ? "default" : "outline"}>{t("SDR")}</Badge>
      {motivo ? <span className="text-xs text-muted-foreground">{motivo}</span> : null}
    </div>
  );
}
