import { defineSchedule } from 'eve/schedules';
import { updateState } from '../lib/store';
import { monitorWorkspace } from '../lib/workspace-monitor';

// A handler-only schedule: no model call. Telegram remains the check-in channel
// when external delivery is enabled, avoiding parallel automatic requests.
export default defineSchedule({ cron: '* * * * *', run() {
  updateState(state => monitorWorkspace(state, new Date().toISOString(), process.env.ASSISTANT_DELIVERY_ENABLED !== 'true'));
} });
