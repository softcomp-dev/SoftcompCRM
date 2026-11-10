---
impacto: capacidade_nova
secao: adicionado
titulo: Função SDR por empresa, ligada e atribuída pela tela de Equipe
---

Cada empresa pode agora ligar a **função SDR** e marcar quais membros da equipe
fazem pré-venda, em **Equipe › Membros**: o cartão "Função SDR" liga a função, e
a tabela ganha uma coluna SDR com uma chave por pessoa. A função vem
**desligada**: quem não a ligar não vê mudança nenhuma.

SDR não é um papel novo. Ele se soma ao papel que a pessoa já tem: um Atendente,
um Gerente ou um Administrador pode ser SDR, e quem tem o papel Somente leitura
não pode. A marca só vale com a função ligada, o membro ativo e papel de
Atendente ou acima. Se a função for desligada, se a pessoa passar a Somente
leitura ou se o acesso dela for revogado, ela perde as permissões de SDR na hora,
sem que ninguém precise desmarcá-la, e a tabela mostra o motivo na linha dela.
Religar a função devolve a equipe como estava.

O mesmo também está na API (`/api/v1/settings/sdr`, `/api/v1/sdr/assignments` e
`/api/v1/sdr/permissions`, com a sessão de quem está logado). Por enquanto a
marca identifica quem é SDR, mas ainda não muda a distribuição de leads nem os
relatórios. Toda mudança fica registrada na auditoria. A atualização acrescenta
uma coluna ao banco e não pede nada a quem opera a VPS.
