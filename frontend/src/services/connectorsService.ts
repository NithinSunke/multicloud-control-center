import { apiRequest } from './api';
import type { ConnectorInput, ProxmoxConnector } from '../types/connectors';

export function listConnectors() {
  return apiRequest<{
    selectedConnectorId: string | null;
    selectedOciConnectorId?: string | null;
    selectedAwsConnectorId?: string | null;
    selectedAzureConnectorId?: string | null;
    selectedGcpConnectorId?: string | null;
    selectedGithubConnectorId?: string | null;
    connectors: ProxmoxConnector[];
  }>('/connectors');
}

export function createConnector(payload: ConnectorInput) {
  return apiRequest<{ connector: ProxmoxConnector }>('/connectors', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateConnector(id: string, payload: ConnectorInput) {
  return apiRequest<{ connector: ProxmoxConnector }>(`/connectors/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function deleteConnector(id: string, confirmation: string) {
  return apiRequest<void>(`/connectors/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmation }),
  });
}

export function selectConnector(id: string) {
  return apiRequest<{ connector: ProxmoxConnector }>(`/connectors/${id}/select`, {
    method: 'POST',
  });
}

export function verifyConnector(id: string) {
  return apiRequest<{ connector: ProxmoxConnector; result: { ok: boolean; message: string } }>(
    `/connectors/${id}/verify`,
    {
      method: 'POST',
    },
  );
}
