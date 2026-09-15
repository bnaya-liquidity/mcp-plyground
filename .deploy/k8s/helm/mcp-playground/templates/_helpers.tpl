{{/* Chart name, overridable. */}}
{{- define "mcp-playground.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "mcp-playground.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "mcp-playground.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "mcp-playground.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: mcp-playground
{{- end -}}

{{/* Per-component selector labels. Usage: include "mcp-playground.selectorLabels" (dict "ctx" $ "component" "mcp") */}}
{{- define "mcp-playground.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mcp-playground.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Service names (stable in-cluster DNS) for cross-component wiring. */}}
{{- define "mcp-playground.otelcol.fullname" -}}{{ include "mcp-playground.fullname" . }}-otelcol{{- end -}}
{{- define "mcp-playground.aspire.fullname" -}}{{ include "mcp-playground.fullname" . }}-aspire{{- end -}}
{{- define "mcp-playground.mcp.fullname" -}}{{ include "mcp-playground.fullname" . }}-mcp{{- end -}}
