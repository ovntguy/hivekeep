import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Textarea } from '@/client/components/ui/textarea'
import { Button } from '@/client/components/ui/button'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { ToggleGroup, ToggleGroupItem } from '@/client/components/ui/toggle-group'
import { Plus, Trash2 } from 'lucide-react'
import { api, getErrorMessage } from '@/client/lib/api'
import type { McpServerData } from '@/client/components/mcp/McpServerCard'
import type { McpTransport } from '@/shared/types'

interface McpServerFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  server?: McpServerData | null
}

interface SecretVar {
  key: string
  value: string
}

type ConnectionKind = 'stdio' | 'remote'

function isRemoteTransport(transport: McpTransport | undefined): boolean {
  return transport === 'http' || transport === 'sse'
}

export function McpServerFormDialog({
  open,
  onOpenChange,
  onSaved,
  server,
}: McpServerFormDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!server

  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [connectionKind, setConnectionKind] = useState<ConnectionKind>('stdio')
  const [httpMode, setHttpMode] = useState<'http' | 'sse'>('http')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envVars, setEnvVars] = useState<SecretVar[]>([])
  const [url, setUrl] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [hasExistingBearer, setHasExistingBearer] = useState(false)
  const [headerVars, setHeaderVars] = useState<SecretVar[]>([])

  useEffect(() => {
    if (open && server) {
      const remote = isRemoteTransport(server.transport)
      setName(server.name)
      setConnectionKind(remote ? 'remote' : 'stdio')
      setHttpMode(server.transport === 'sse' ? 'sse' : 'http')
      setCommand(server.command ?? '')
      setArgsText((server.args ?? []).join('\n'))
      setEnvVars(
        server.env
          ? Object.entries(server.env).map(([key]) => ({ key, value: '' }))
          : [],
      )
      setUrl(server.url ?? '')
      const headerEntries = server.headers
        ? Object.entries(server.headers).map(([key]) => ({ key, value: '' }))
        : []
      const authHeader = headerEntries.find((h) => h.key.toLowerCase() === 'authorization')
      setHasExistingBearer(!!authHeader)
      setBearerToken('')
      setHeaderVars(headerEntries.filter((h) => h.key.toLowerCase() !== 'authorization'))
      setError('')
    } else if (open) {
      setName('')
      setConnectionKind('stdio')
      setHttpMode('http')
      setCommand('')
      setArgsText('')
      setEnvVars([])
      setUrl('')
      setBearerToken('')
      setHasExistingBearer(false)
      setHeaderVars([])
      setError('')
    }
  }, [open, server])

  const handleClose = () => {
    onOpenChange(false)
  }

  const addSecretVar = (setter: (fn: (prev: SecretVar[]) => SecretVar[]) => void) => {
    setter((prev) => [...prev, { key: '', value: '' }])
  }

  const removeSecretVar = (setter: (fn: (prev: SecretVar[]) => SecretVar[]) => void, index: number) => {
    setter((prev) => prev.filter((_, i) => i !== index))
  }

  const updateSecretVar = (
    setter: (fn: (prev: SecretVar[]) => SecretVar[]) => void,
    index: number,
    field: 'key' | 'value',
    val: string,
  ) => {
    setter((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item)),
    )
  }

  const buildSecretObject = (
    vars: SecretVar[],
    existing: Record<string, string> | null | undefined,
  ): Record<string, string> | undefined => {
    const filtered = vars.filter((v) => v.key.trim() !== '')
    if (filtered.length === 0) return undefined

    const result: Record<string, string> = {}
    for (const v of filtered) {
      const key = v.key.trim()
      if (v.value) {
        result[key] = v.value
      } else if (isEditing && existing && existing[key] !== undefined) {
        result[key] = existing[key] ?? ''
      } else {
        result[key] = ''
      }
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  const buildHeaders = (): Record<string, string> | undefined => {
    const extra = buildSecretObject(headerVars, server?.headers) ?? {}
    const headers: Record<string, string> = { ...extra }

    if (bearerToken.trim()) {
      headers.Authorization = `Bearer ${bearerToken.trim()}`
    } else if (isEditing && hasExistingBearer && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
      headers.Authorization = ''
    }

    return Object.keys(headers).length > 0 ? headers : undefined
  }

  const handleSave = async () => {
    setError('')
    setIsSaving(true)
    try {
      const transport: McpTransport = connectionKind === 'remote' ? httpMode : 'stdio'
      const args = argsText
        .split('\n')
        .map((a) => a.trim())
        .filter((a) => a !== '')
      const payload = connectionKind === 'remote'
        ? { name, transport, url: url.trim(), headers: buildHeaders() }
        : { name, transport, command, args, env: buildSecretObject(envVars, server?.env) }

      if (isEditing) {
        await api.patch(`/mcp-servers/${server!.id}`, payload)
      } else {
        await api.post('/mcp-servers', payload)
      }
      onSaved()
      handleClose()
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  const canSave = name.trim() !== '' && (
    connectionKind === 'stdio' ? command.trim() !== '' : url.trim() !== ''
  )

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => { if (!v) handleClose() }}
      title={isEditing ? t('settings.mcp.edit') : t('settings.mcp.add')}
      description={isEditing ? t('settings.mcp.editHint') : t('settings.mcp.addHint')}
      size="lg"
      error={error || null}
      onSubmit={handleSave}
      isSubmitting={isSaving}
      submitDisabled={!canSave}
      submitLabel={isEditing ? t('common.save') : t('settings.mcp.add')}
    >
      <FormField
        label={t('settings.mcp.name')}
        htmlFor="mcp-name"
        tip={t('settings.mcp.nameTip')}
        required
      >
        <Input
          id="mcp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.mcp.namePlaceholder')}
        />
      </FormField>

      <FormField
        label={t('settings.mcp.transport')}
        tip={t('settings.mcp.transportTip')}
      >
        <ToggleGroup
          type="single"
          variant="outline"
          value={connectionKind}
          onValueChange={(v) => { if (v) setConnectionKind(v as ConnectionKind) }}
          className="w-full sm:w-auto justify-start"
        >
          <ToggleGroupItem value="stdio" className="flex-1 sm:flex-none">
            {t('settings.mcp.transportStdio')}
          </ToggleGroupItem>
          <ToggleGroupItem value="remote" className="flex-1 sm:flex-none">
            {t('settings.mcp.transportRemote')}
          </ToggleGroupItem>
        </ToggleGroup>
      </FormField>

      {connectionKind === 'stdio' ? (
        <>
          <FormField
            label={t('settings.mcp.command')}
            htmlFor="mcp-command"
            tip={t('settings.mcp.commandTip')}
            required
          >
            <Input
              id="mcp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={t('settings.mcp.commandPlaceholder')}
              className="font-mono"
            />
          </FormField>

          <FormField
            label={
              <>
                {t('settings.mcp.args')}
                <span className="ml-1 text-xs text-muted-foreground">
                  ({t('common.optional')})
                </span>
              </>
            }
            htmlFor="mcp-args"
            tip={t('settings.mcp.argsTip')}
          >
            <Textarea
              id="mcp-args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={t('settings.mcp.argsPlaceholder')}
              rows={3}
              className="font-mono text-sm"
            />
          </FormField>

          <FormField
            label={
              <>
                {t('settings.mcp.env')}
                <span className="ml-1 text-xs text-muted-foreground">
                  ({t('common.optional')})
                </span>
              </>
            }
            tip={t('settings.mcp.envTip')}
            hint={
              isEditing && envVars.length > 0
                ? t('settings.mcp.envPreserveHint')
                : undefined
            }
          >
            <SecretVarList
              vars={envVars}
              editing={isEditing}
              keyPlaceholder={t('settings.mcp.envKeyPlaceholder')}
              valuePlaceholder={t('settings.mcp.envValuePlaceholder')}
              addLabel={t('settings.mcp.addEnvVar')}
              onAdd={() => addSecretVar(setEnvVars)}
              onRemove={(i) => removeSecretVar(setEnvVars, i)}
              onChange={(i, field, val) => updateSecretVar(setEnvVars, i, field, val)}
            />
          </FormField>
        </>
      ) : (
        <>
          <FormField
            label={t('settings.mcp.url')}
            htmlFor="mcp-url"
            tip={t('settings.mcp.urlTip')}
            required
          >
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('settings.mcp.urlPlaceholder')}
              className="font-mono"
            />
          </FormField>

          <FormField
            label={t('settings.mcp.httpMode')}
            tip={t('settings.mcp.httpModeTip')}
          >
            <ToggleGroup
              type="single"
              variant="outline"
              value={httpMode}
              onValueChange={(v) => { if (v === 'http' || v === 'sse') setHttpMode(v) }}
              className="w-full sm:w-auto justify-start"
            >
              <ToggleGroupItem value="http" className="flex-1 sm:flex-none">
                {t('settings.mcp.httpStreamable')}
              </ToggleGroupItem>
              <ToggleGroupItem value="sse" className="flex-1 sm:flex-none">
                {t('settings.mcp.httpSse')}
              </ToggleGroupItem>
            </ToggleGroup>
          </FormField>

          <FormField
            label={
              <>
                {t('settings.mcp.bearerToken')}
                <span className="ml-1 text-xs text-muted-foreground">
                  ({t('common.optional')})
                </span>
              </>
            }
            htmlFor="mcp-bearer"
            tip={t('settings.mcp.bearerTokenTip')}
            hint={
              isEditing && hasExistingBearer
                ? t('settings.mcp.bearerTokenPreserveHint')
                : undefined
            }
          >
            <PasswordInput
              id="mcp-bearer"
              value={bearerToken}
              onChange={(e) => setBearerToken(e.target.value)}
              placeholder={isEditing && hasExistingBearer ? '••••••••' : t('settings.mcp.bearerTokenPlaceholder')}
              autoComplete="off"
            />
          </FormField>

          <FormField
            label={
              <>
                {t('settings.mcp.headers')}
                <span className="ml-1 text-xs text-muted-foreground">
                  ({t('common.optional')})
                </span>
              </>
            }
            tip={t('settings.mcp.headersTip')}
            hint={
              isEditing && headerVars.length > 0
                ? t('settings.mcp.headersPreserveHint')
                : undefined
            }
          >
            <SecretVarList
              vars={headerVars}
              editing={isEditing}
              keyPlaceholder={t('settings.mcp.headerKeyPlaceholder')}
              valuePlaceholder={t('settings.mcp.headerValuePlaceholder')}
              addLabel={t('settings.mcp.addHeader')}
              onAdd={() => addSecretVar(setHeaderVars)}
              onRemove={(i) => removeSecretVar(setHeaderVars, i)}
              onChange={(i, field, val) => updateSecretVar(setHeaderVars, i, field, val)}
            />
          </FormField>
        </>
      )}
    </FormDialog>
  )
}

function SecretVarList({
  vars,
  editing,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onAdd,
  onRemove,
  onChange,
}: {
  vars: SecretVar[]
  editing: boolean
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  onAdd: () => void
  onRemove: (index: number) => void
  onChange: (index: number, field: 'key' | 'value', val: string) => void
}) {
  return (
    <div className="space-y-2">
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={v.key}
            onChange={(e) => onChange(i, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            className="font-mono text-sm flex-[2]"
          />
          <PasswordInput
            value={v.value}
            onChange={(e) => onChange(i, 'value', e.target.value)}
            placeholder={editing ? '••••••••' : valuePlaceholder}
            className="text-sm flex-[3]"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => onRemove(i)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={onAdd} className="text-xs">
        <Plus className="size-3.5" />
        {addLabel}
      </Button>
    </div>
  )
}
