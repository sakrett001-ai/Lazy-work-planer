import { assertWebReadOnly } from '../lib/prototype';
import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { currentEmployee, updateState } from '../lib/store';
import { sendToEmployee } from '../lib/telegram';

export default defineTool({
  description: 'Отправить исполнителю уведомление по задаче. Только руководителю. Возвращает фактический результат доставки; draft, failed, uncertain и prepared не означают отправку. Повтор одного вызова не отправляет сообщение заново.',
  inputSchema: z.object({
    taskId: z.string().min(1).max(80),
    kind: z.enum(['task_assigned', 'check_in', 'decision_notice']),
    message: z.string().trim().min(1).max(2000).optional(),
  }),
  async execute({ taskId, kind, message }, ctx) {
    assertWebReadOnly(ctx);
    const actor = currentEmployee(ctx);
    if (actor.role !== 'manager') throw new Error('Отправка доступна только руководителю');
    if (!ctx.callId) throw new Error('Нет устойчивого идентификатора вызова');
    const id = 'notify:' + actor.id + ':' + ctx.callId;
    let notification: any;
    updateState(state => {
      const previous = state.notifications?.find(n => n.id === id);
      if (previous) {
        if (previous.taskId !== taskId || previous.kind !== kind || previous.requestMessage !== (message || null)) throw new Error('Повтор вызова содержит другое действие');
        notification = previous;
        return state;
      }
      const next = structuredClone(state), task = next.tasks.find(t => t.id === taskId);
      if (!task) throw new Error('Задача не найдена');
      if (kind === 'check_in' && ['done', 'review'].includes(task.status)) throw new Error('Для этой задачи запрос статуса не требуется');
      const employee = next.employees.find(p => p.id === task.employeeId);
      if (!employee) throw new Error('Исполнитель не найден');
      const text = message || (kind === 'check_in'
        ? employee.name + ', подскажите статус ' + task.id + ' «' + task.title + '»: что готово, что мешает и нужна ли помощь?'
        : kind === 'task_assigned'
          ? employee.name + ', вам назначено ' + task.id + ' «' + task.title + '». Срок: ' + (task.due || 'не задан') + '. ' + (task.summary || '')
          : employee.name + ', по ' + task.id + ': ' + (task.nextAction || task.summary || 'уточните решение у руководителя'));
      notification = { id, taskId, kind, authorId: actor.id, to: employee.id, recipientName: employee.name, at: new Date().toISOString(),
        title: (kind === 'check_in' ? 'Запрос статуса ' : kind === 'task_assigned' ? 'Новое поручение ' : 'Сообщение по решению ') + taskId,
        text, requestMessage: message || null, channel: employee.telegramId ? 'telegram' : 'unavailable', delivery: 'prepared' };
      // Keep the durable operation; the UI decides how many notifications to display.
      next.notifications = [notification, ...(next.notifications || [])];
      return next;
    });
    let delivery: { status: string; duplicate: boolean; sentAt?: string | null };
    let error: string | null = null;
    try {
      delivery = await sendToEmployee(notification.to, notification.text, id);
    } catch (cause) {
      delivery = { status: 'failed', duplicate: false };
      error = cause instanceof Error ? cause.message : 'Не удалось подготовить доставку';
    }
    updateState(state => {
      const next = structuredClone(state), record = next.notifications?.find(n => n.id === id);
      if (!record) throw new Error('Запись уведомления не найдена');
      record.delivery = delivery.status;
      record.deliveryError = error;
      record.sentAt = delivery.sentAt || null;
      const eventKey = id + ':' + delivery.status;
      if (!next.events.some(e => e.key === eventKey)) next.events.unshift({
        key: eventKey, taskId, kind: delivery.status === 'sent' ? 'notification_sent' : 'notification_pending',
        at: delivery.sentAt || new Date().toISOString(), actorId: actor.id, deliveryId: id, delivery: delivery.status,
        text: (delivery.status === 'sent' ? 'Сообщение отправлено: ' : 'Отправка не подтверждена: ') + record.title,
      });
      if (kind === 'check_in' && delivery.status === 'sent' && delivery.sentAt) {
        const task = next.tasks.find(t => t.id === taskId);
        if (task && !['done', 'review'].includes(task.status) && (!task.lastRequestedAt || Date.parse(task.lastRequestedAt) < Date.parse(delivery.sentAt))) {
          task.lastRequestedAt = delivery.sentAt;
          if (!task.lastReply || Date.parse(task.lastReply) < Date.parse(delivery.sentAt)) task.contact = 'awaiting';
        }
      }
      notification = record;
      return next;
    });
    return { notified: delivery.status === 'sent', delivery: delivery.status, duplicate: delivery.duplicate, error, notification };
  },
});
