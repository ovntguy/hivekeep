import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Plus , Plug} from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { api, getErrorMessage, toastError } from '@/client/lib/api'
import { FormErrorAlert } from '@/client/components/common/FormErrorAlert'
import { useSSE } from '@/client/hooks/useSSE'
import { useAgentList } from '@/client/hooks/useAgentList'
import { McpServerCard, type McpServerData } from '@/client/components/mcp/McpServerCard'
import { McpServerFormDialog } from '@/client/components/mcp/McpServerFormDialog'

export function McpServersSettings() {
  const { t } = useTranslation()
  const [servers, setServers] = useState<McpServerData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { agentNames, agentAvatars } = useAgentList()
  const [modalOpen, setModalOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<McpServerData | null>(null)

  useEffect(() => {
    fetchServers()
  }, [])

  useSSE({
    'mcp-server:created': () => fetchServers(),
    'mcp-server:updated': () => fetchServers(),
    'mcp-server:deleted': (data) => {
      const serverId = data.serverId as string
      setServers((prev) => prev.filter((s) => s.id !== serverId))
    },
  })

  const fetchServers = async () => {
    setFetchError(null)
    try {
      const data = await api.get<{ servers: McpServerData[] }>('/mcp-servers')
      setServers(data.servers)
    } catch (err: unknown) {
      setFetchError(getErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }

  const handleApprove = async (serverId: string) => {
    try {
      await api.post(`/mcp-servers/${serverId}/approve`)
      await fetchServers()
      toast.success(t('settings.mcp.approved'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleDeleteServer = async (id: string) => {
    try {
      await api.delete(`/mcp-servers/${id}`)
      await fetchServers()
      toast.success(t('settings.mcp.deleted'))
    } catch (err: unknown) {
      toastError(err)
    }
  }

  const handleSaved = async () => {
    await fetchServers()
    toast.success(editingServer ? t('settings.mcp.saved') : t('settings.mcp.added'))
  }

  const openAdd = () => {
    setEditingServer(null)
    setModalOpen(true)
  }

  const openEdit = (server: McpServerData) => {
    setEditingServer(server)
    setModalOpen(true)
  }

  const list = useListControls(servers, {
    searchText: (s) => [s.name, s.command ?? '', s.url ?? '', s.transport],
  })

  if (isLoading) {
    return <SettingsListSkeleton count={2} />
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <FormErrorAlert error={fetchError} />
        <Button variant="outline" onClick={fetchServers}>
          {t('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('settings.mcp.description')}
        </p>
      </div>

      <HelpPanel
        contentKey="settings.mcp.help.content"
        bulletKeys={[
          'settings.mcp.help.bullet1',
          'settings.mcp.help.bullet2',
          'settings.mcp.help.bullet3',
          'settings.mcp.help.bullet4',
          'settings.mcp.help.bullet5',
        ]}
        storageKey="help.mcp.open"
      />

      {servers.length === 0 && (
        <EmptyState
          icon={Plug}
          title={t('settings.mcp.empty')}
          description={t('settings.mcp.emptyDescription')}
          actionLabel={t('settings.mcp.add')}
          onAction={openAdd}
        />
      )}

      {servers.length >= LIST_FILTER_THRESHOLD && (
        <ListToolbar
          query={list.query}
          onQueryChange={list.setQuery}
          placeholder={t('settings.mcp.search', 'Search servers...')}
          onClear={() => list.setQuery('')}
          active={list.isSearching}
        />
      )}

      {servers.length > 0 && list.total === 0 && (
        <EmptyState minimal title={t('common.noResults', 'No results found')} />
      )}

      {list.filtered.map((server) => (
        <McpServerCard
          key={server.id}
          server={server}
          agentName={server.createdByAgentId ? agentNames.get(server.createdByAgentId) : undefined}
          agentAvatarUrl={server.createdByAgentId ? agentAvatars.get(server.createdByAgentId) : undefined}
          onApprove={() => handleApprove(server.id)}
          onEdit={() => openEdit(server)}
          onDelete={() => handleDeleteServer(server.id)}
        />
      ))}

      <Button variant="outline" onClick={openAdd} className="w-full">
        <Plus className="size-4" />
        {t('settings.mcp.add')}
      </Button>

      <McpServerFormDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        onSaved={handleSaved}
        server={editingServer}
      />

    </div>
  )
}
