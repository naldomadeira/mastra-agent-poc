import { NextResponse } from 'next/server';
import { checkHealth } from '@/infrastructure/database/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const report = await checkHealth();
  return NextResponse.json(report, { status: report.status === 'ok' ? 200 : 503 });
}
