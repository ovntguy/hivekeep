import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Card, CardContent } from '@/client/components/ui/card'
import { AgentBadge } from '@/client/components/common/AgentBadge'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { CheckCircle, Pencil, Plug, RefreshCw, Loader2 } from 'lucide-react'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { cn } from '@/client/lib/utils'
import { api } from '@/client/lib/api'
import type { McpTransport } from '@/shared/types'

export interface McpServerData {
  id: string
  name: string
  transport?: McpTransport
  command: string | null
  args: string[]
  env: Record<string, string> | null
  url: string | null
  headers: Record<string, string> | null
  status: string
  createdByAgentId: string | null
  createdAt: number
  updatedAt: number
}

interface McpServerCardProps {
  server: McpServerData
  agentName?: string
  agentAvatarUrl?: string | null
  onApprove?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

interface ConnectionStatus {
  connected: boolean
  toolCount: number
  error?: string
}

export function McpServerCard({ server, agentName, agentAvatarUrl, onApprove, onEdit, onDelete }: McpServerCardProps) {
  const { t } = useTranslation()
  const [connStatus, setConnStatus] = useState<ConnectionStatus | null>(null)
  const [testing, setTesting] = useState(false)

  const isPending = server.status === 'pending_approval'
  const transport = server.transport ?? 'stdio'
  const isRemote = transport === 'http' || transport === 'sse'
  const envKeys = server.env ? Object.keys(server.env) : []
  const headerKeys = server.headers
    ? Object.keys(server.headers).filter((k) => k.toLowerCase() !== 'authorization')
    : []
  const subtitle = isRemote
    ? (server.url || '')
    : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')

  // Fetch connection status on mount for active servers
  useEffect(() => {
    if (isPending) return
    api.get<ConnectionStatus>(`/mcp-servers/${server.id}/status`)
      .then((s) => { if (s) setConnStatus(s) })
      .catch(() => {})
  }, [server.id, isPending])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      const s = await api.post<ConnectionStatus>(`/mcp-servers/${server.id}/test`)
      if (s) setConnStatus(s)
    } catch {
      setConnStatus({ connected: false, toolCount: 0, error: 'Test request failed' })
    } finally {
      setTesting(false)
    }
  }, [server.id])

  return (
    <Card className="surface-card">
      <CardContent className="flex items-center justify-between py-3 px-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="shrink-0 relative">
            <Plug className="size-5 text-muted-foreground" />
            {!isPending && connStatus && (
              <span className={cn(
                'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-1 ring-background',
                connStatus.connected ? 'bg-emerald-500' : 'bg-destructive',
              )} />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium truncate">{server.name}</p>
              {isRemote && (
                <Badge variant="outline" size="xs" className="shrink-0">
                  {transport === 'sse' ? t('settings.mcp.httpSse') : t('settings.mcp.httpStreamable')}
                </Badge>
              )}
              {isPending ? (
                <Badge variant="outline" size="xs" className="shrink-0 border-warning text-warning">
                  {t('settings.mcp.statusPending')}
                </Badge>
              ) : (
                <Badge variant="secondary" size="xs" className="shrink-0">
                  {t('settings.mcp.statusActive')}
                </Badge>
              )}
              {!isPending && connStatus?.connected && connStatus.toolCount > 0 && (
                <Badge variant="secondary" size="xs" className="shrink-0 text-muted-foreground">
                  {t('settings.mcp.toolCount', { count: connStatus.toolCount })}
                </Badge>
              )}
              {!isPending && connStatus && !connStatus.connected && connStatus.error && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" size="xs" className="shrink-0 border-destructive text-destructive cursor-help">
                      {t('settings.mcp.connectionError')}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-64 text-xs">
                    {connStatus.error}
                  </TooltipContent>
                </Tooltip>
              )}
              {server.createdByAgentId && agentName && (
                <AgentBadge name={agentName} avatarUrl={agentAvatarUrl} />
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate font-mono">
              {subtitle}
            </p>
            {envKeys.length > 0 && (
              <p className="text-xs text-muted-foreground/70 truncate font-mono">
                {envKeys.join(', ')}
              </p>
            )}
            {headerKeys.length > 0 && (
              <p className="text-xs text-muted-foreground/70 truncate font-mono">
                {headerKeys.join(', ')}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPending && onApprove && (
            <Button variant="outline" size="sm" onClick={onApprove} className="text-xs h-7 px-2">
              <CheckCircle className="size-3.5" />
              {t('settings.mcp.approve')}
            </Button>
          )}
          {!isPending && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" onClick={handleTest} disabled={testing}>
                  {testing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('settings.mcp.testConnection')}</TooltipContent>
            </Tooltip>
          )}
          {onEdit && (
            <Button variant="ghost" size="icon-xs" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
          )}
          {onDelete && (
            <ConfirmDeleteButton
              onConfirm={onDelete}
              title={t('settings.mcp.delete')}
              description={t('settings.mcp.deleteConfirm')}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
