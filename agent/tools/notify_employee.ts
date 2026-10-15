import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, updateState } from '../lib/store';
import { sendToEmployee } from '../lib/telegram';

export default defineTool({
  description: 'Уведомить сотрудника о новом поручении, запросить статус реализации или передать решение руководителя по задаче. Доступно только руководителю.',
  inputSchema: z.object({
    taskId: z.string().min(1).max(80),
    kind: z.enum(['task_assigned', 'check_in', 'decision_notice']),
    message: z.string().trim().min(1).max(2000).optional(),
  }),
  async execute({ taskId, kind, message }, ctx) {
    const actor = currentEmployee(ctx);
    if (actor.role !== 'manager') throw new Error('Отправка уведомлений сотрудникам доступна только руководителю');

    const now = new Date().toISOString();
    let targetEmployeeId = '';
    let textToSend = '';
    let notificationRecord: any = null;

    updateState(state => {
      const next = structuredClone(state);
      const task = next.tasks.find(t => t.id === taskId);
      if (!task) throw new Error('Задача не найдена');
      const emp = next.employees.find(e => e.id === task.employeeId);
      if (!emp) throw new Error('Исполнитель задачи не найден');
      targetEmployeeId = emp.id;

      if (kind === 'task_assigned') {
        textToSend = message || `${emp.name}, вам поступило поручение ${task.id} «${task.title}»${task.due ? ` (срок: ${task.due})` : ''}.\nОписание: ${task.summary || 'детали в карточке задачи'}.\nСообщите, если есть вопросы или препятствия.`;
      } else if (kind === 'check_in') {
        textToSend = message || `${emp.name}, подскажите статус реализации поручения ${task.id} «${task.title}»${task.due ? ` (срок: ${task.due})` : ''}: что готово, есть ли проблемы и нужна ли помощь?`;
        task.lastRequestedAt = now;
        if (task.contact === 'answered') task.contact = 'awaiting';
      } else {
        textToSend = message || `${emp.name}, по поручению ${task.id} «${task.title}» принято решение руководителя: ${task.nextAction || task.summary}`;
      }

      notificationRecord = {
        id: `notif:${task.id}:${kind}:${Date.parse(now)}`,
        at: now,
        to: emp.id,
        recipientName: emp.name,
        taskId: task.id,
        kind,
        severity: kind === 'task_assigned' ? 'cyan' : kind === 'check_in' ? 'violet' : 'mint',
        title: kind === 'task_assigned' ? `Новое поручение ${task.id}` : kind === 'check_in' ? `Запрос статуса ${task.id}` : `Решение по ${task.id}`,
        text: textToSend,
        channel: emp.telegramId ? 'telegram' : 'dashboard',
      };

      next.notifications = [notificationRecord, ...(next.notifications || [])].slice(0, 60);
      next.events.unshift({
        key: notificationRecord.id,
        taskId: task.id,
        kind: `notify_${kind}`,
        at: now,
        text: `${notificationRecord.title} → ${emp.name}`,
      });
      return next;
    });

    let delivery = { status: 'local_only', duplicate: false };
    try {
      delivery = await sendToEmployee(targetEmployeeId, textToSend, `notify:${taskId}:${kind}:${now.slice(0, 16)}`);
    } catch {
      delivery = { status: 'draft', duplicate: false };
    }

    return {
      notified: true,
      delivery: delivery.status,
      notification: notificationRecord,
    };
  },
});
