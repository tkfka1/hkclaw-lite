{{- define "hkclaw-lite.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hkclaw-lite.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "hkclaw-lite.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "hkclaw-lite.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hkclaw-lite.labels" -}}
helm.sh/chart: {{ include "hkclaw-lite.chart" . }}
app.kubernetes.io/name: {{ include "hkclaw-lite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "hkclaw-lite.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hkclaw-lite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "hkclaw-lite.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "hkclaw-lite.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "hkclaw-lite.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "hkclaw-lite.statePvcName" -}}
{{- printf "%s-state" (include "hkclaw-lite.fullname" .) -}}
{{- end -}}

{{- define "hkclaw-lite.workspacePvcName" -}}
{{- printf "%s-workspace" (include "hkclaw-lite.fullname" .) -}}
{{- end -}}

{{- define "hkclaw-lite.bootstrapSecretName" -}}
{{- if .Values.bootstrapBackup.existingSecret -}}
{{- .Values.bootstrapBackup.existingSecret -}}
{{- else -}}
{{- printf "%s-bootstrap" (include "hkclaw-lite.fullname" .) -}}
{{- end -}}
{{- end -}}
