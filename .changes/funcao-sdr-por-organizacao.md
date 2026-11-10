---
impacto: capacidade_nova
secao: adicionado
titulo: Função SDR por empresa, com os leads novos distribuídos só entre os SDRs
---

Cada empresa escolhe agora entre dois fluxos de atendimento: o de sempre, em que
os leads novos vão para a equipe inteira, ou o fluxo **SDR**, em que só quem faz a
pré-venda recebe os leads novos. A função vem **desligada**: quem não a ligar não
vê mudança nenhuma.

Em **Equipe › Membros**, o cartão "Função SDR" liga a função, e a tabela ganha uma
coluna SDR com uma chave por pessoa. O cartão diz para onde estão indo os leads
novos naquele momento. Com ao menos um SDR ativo, a distribuição automática
(rodízio ou por carga) entrega a conversa nova só aos SDRs. Se todos estiverem
ocupados ou fora do horário, o lead espera um SDR em vez de ir para outra pessoa.
Com a função ligada e ninguém marcado, nada para: os leads seguem para a equipe.
A regra dos responsáveis por número e a das filas continuam valendo junto, e o
destino padrão de um número continua indo para a pessoa escolhida.

SDR não é um papel novo. Ele se soma ao papel que a pessoa já tem: um Atendente,
um Gerente ou um Administrador pode ser SDR, e quem tem o papel Somente leitura
não pode. Se a função for desligada, se a pessoa passar a Somente leitura ou se o
acesso dela for revogado, ela deixa de receber leads como SDR na hora, sem que
ninguém precise desmarcá-la, e a tabela mostra o motivo na linha dela. Religar a
função devolve a equipe como estava.

O mesmo está na API (`/api/v1/settings/sdr`, `/api/v1/sdr/assignments` e
`/api/v1/sdr/permissions`, com a sessão de quem está logado). Toda mudança fica
registrada na auditoria. A atualização acrescenta uma coluna ao banco e não pede
nada a quem opera a VPS.
