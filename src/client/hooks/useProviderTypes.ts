import { useEffect, useMemo, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import {
  PROVIDER_API_KEY_URLS,
  PROVIDER_CAPABILITIES,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_TYPES,
  PROVIDERS_WITHOUT_API_KEY,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from '@/shared/constants'
import type { ConfigField } from '@hivekeep/sdk'
import {
  registerProviderLobehubIcon,
  registerProviderReactIcon,
} from '@/client/components/common/ProviderIcon'

export interface ProviderTypeInfo {
  type: string
  displayName: string
  capabilities: string[]
  noApiKey: boolean
  optionalApiKey: boolean
  apiKeyUrl?: string
  lobehubIcon?: string
  reactIcon?: string
  brandColor?: string
  source: 'builtin' | 'plugin'
  configSchema?: ConfigField[]
  oauth?: { redirectStyle: 'page' | 'loopback' }
}
