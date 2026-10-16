import { issueInvite } from '../agent/lib/web-auth.ts';
const employeeId = process.argv[2];
if (!employeeId || process.argv.length !== 3) throw new Error('Укажите ID зарегистрированного участника: npm run pilot:invite -- employee-1');
console.log(`Одноразовый код для ${employeeId}, действителен 30 минут:\n${issueInvite(employeeId)}\nПередайте участнику лично. Не сохраняйте в Git, URL или общих журналах.`);
