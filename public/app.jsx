const { useEffect, useMemo, useRef, useState } = React;

const formatBytes = (bytes) => {
  if (!bytes) return '-';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${sizes[index]}`;
};

const formatDate = (value) => {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
};

const isSubtitleFile = (name) => name.toLowerCase().endsWith('.srt');
const isVideoFile = (name) => name.toLowerCase().endsWith('.mp4');
const APP_VERSION = '1.0.0';
const stripLogTimestamp = (entry) => String(entry || '').replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
const truncateLogLine = (entry, maxLength = 80) => {
  const text = stripLogTimestamp(entry);
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
};
const extractUrlFromLogEntry = (entry) => {
  const text = stripLogTimestamp(entry).trim();
  const absoluteUrlMatch = text.match(/https?:\/\/[^\s"']+/i);
  if (absoluteUrlMatch?.[0]) {
    return absoluteUrlMatch[0].replace(/[),.;]+$/, '');
  }

  const hostPathMatch = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"']*)?/i);
  if (hostPathMatch?.[0]) {
    return hostPathMatch[0].replace(/[),.;]+$/, '');
  }

  return text;
};
const getManagedEntryKey = (entry) => String(entry?.key || '');
const getManagedEntryLabel = (entry) => String(entry?.isRegex ? `regex:${entry.value || ''}` : entry?.value || '');

const copyText = async (value) => {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);

  if (!copied) {
    throw new Error('Failed to copy proxy logs');
  }
};

function App() {
  const currentPage = window.location.pathname.startsWith('/proxy') ? 'proxy' : 'files';
  const isProxyPage = currentPage === 'proxy';
  const [basePath, setBasePath] = useState('/mnt');
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState(null);
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState({ fileCount: 0, folderCount: 0, totalSize: 0 });
  const [sortKey, setSortKey] = useState('type');
  const [sortDirection, setSortDirection] = useState('asc');
  const [loading, setLoading] = useState(!isProxyPage);
  const [actionLoading, setActionLoading] = useState(false);
  const [notification, setNotification] = useState(null);
  const [renameAssistantOpen, setRenameAssistantOpen] = useState(false);
  const [renameSuggestions, setRenameSuggestions] = useState([]);
  const [scanLoading, setScanLoading] = useState(false);
  const [updateLoading, setUpdateLoading] = useState(false);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [whitelistEntries, setWhitelistEntries] = useState([]);
  const [whitelistInput, setWhitelistInput] = useState('');
  const [whitelistInputIsRegex, setWhitelistInputIsRegex] = useState(false);
  const [whitelistSubmitting, setWhitelistSubmitting] = useState(false);
  const [removingWhitelistEntry, setRemovingWhitelistEntry] = useState('');
  const [selectedWhitelistEntries, setSelectedWhitelistEntries] = useState([]);
  const [editingWhitelistEntry, setEditingWhitelistEntry] = useState('');
  const [editingWhitelistValue, setEditingWhitelistValue] = useState('');
  const [editingWhitelistIsRegex, setEditingWhitelistIsRegex] = useState(false);
  const [logFilterLoading, setLogFilterLoading] = useState(isProxyPage);
  const [logFilterEntries, setLogFilterEntries] = useState([]);
  const [logFilterCounts, setLogFilterCounts] = useState({});
  const [logFilterInput, setLogFilterInput] = useState('');
  const [logFilterInputIsRegex, setLogFilterInputIsRegex] = useState(false);
  const [logFilterSubmitting, setLogFilterSubmitting] = useState(false);
  const [removingLogFilterEntry, setRemovingLogFilterEntry] = useState('');
  const [selectedLogFilterEntries, setSelectedLogFilterEntries] = useState([]);
  const [editingLogFilterEntry, setEditingLogFilterEntry] = useState('');
  const [editingLogFilterValue, setEditingLogFilterValue] = useState('');
  const [editingLogFilterIsRegex, setEditingLogFilterIsRegex] = useState(false);
  const [resetLogFilterCountsLoading, setResetLogFilterCountsLoading] = useState(false);
  const [clearLogsLoading, setClearLogsLoading] = useState(false);
  const [copyLogsLoading, setCopyLogsLoading] = useState(false);
  const [proxyLogsLoading, setProxyLogsLoading] = useState(isProxyPage);
  const [proxyLogs, setProxyLogs] = useState([]);
  const [logEntryModalOpen, setLogEntryModalOpen] = useState(false);
  const [logEntryValue, setLogEntryValue] = useState('');
  const [logEntryMode, setLogEntryMode] = useState('hide');
  const [logEntryIsRegex, setLogEntryIsRegex] = useState(false);
  const [logEntrySubmitting, setLogEntrySubmitting] = useState(false);
  const [rootPathLoading, setRootPathLoading] = useState(false);
  const [passwordSetupRequired, setPasswordSetupRequired] = useState(false);
  const [passwordSetupLoading, setPasswordSetupLoading] = useState(true);
  const [passwordSetupPassword, setPasswordSetupPassword] = useState('');
  const [passwordSetupConfirm, setPasswordSetupConfirm] = useState('');
  const [passwordSetupSubmitting, setPasswordSetupSubmitting] = useState(false);
  const [floatingToolsPosition, setFloatingToolsPosition] = useState({ x: 24, y: 160 });
  const [serviceStatus, setServiceStatus] = useState({
    service: 'jellyfin-file-manager',
    status: 'checking',
  });
  const [proxyStatus, setProxyStatus] = useState({
    state: 'checking',
    running: false,
    starting: false,
    port: 3001,
    startedAt: null,
  });
  const [activeRenameIndex, setActiveRenameIndex] = useState(0);
  const [playerItem, setPlayerItem] = useState(null);
  const fileInputRef = useRef(null);
  const updateInputRef = useRef(null);
  const tableRef = useRef(null);
  const renamePanelRef = useRef(null);
  const floatingToolsRef = useRef(null);
  const floatingToolsDragRef = useRef(null);
  const logBoxRef = useRef(null);

  const showNotification = (type, message) => {
    setNotification({ type, message });
    window.clearTimeout(showNotification.timeoutId);
    showNotification.timeoutId = window.setTimeout(() => {
      setNotification(null);
    }, 2800);
  };

  const callJson = async (url, options) => {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || 'Request failed');
    }

    return payload;
  };

  const applyProxyStatus = (payload, fallbackStatus = proxyStatus) => {
    setProxyStatus({
      state: Boolean(payload.running) ? 'online' : 'offline',
      running: Boolean(payload.running),
      starting: Boolean(payload.starting),
      port: Number(payload.port) || fallbackStatus.port || 3001,
      startedAt: payload.startedAt || null,
    });
  };

  const fetchAuthStatus = async () => {
    try {
      const payload = await callJson('/api/auth/status');
      setPasswordSetupRequired(Boolean(payload.passwordChangeRequired));
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setPasswordSetupLoading(false);
    }
  };

  const fetchDirectory = async (targetPath = currentPath, searchTerm = search) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (targetPath) params.set('path', targetPath);
      if (searchTerm) params.set('search', searchTerm);

      const response = await fetch(`/api/files?${params.toString()}`);
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load files');
      }

      setBasePath(payload.basePath || '/mnt');
      setCurrentPath(payload.currentPath);
      setParentPath(payload.parentPath);
      setItems(payload.items);
      setStats(payload.stats);
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchServiceStatus = async () => {
    try {
      const response = await fetch('/api/files/service-status');
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load service status');
      }

      setServiceStatus({
        service: payload.service || 'jellyfin-file-manager',
        status: payload.status || 'offline',
      });
    } catch (_) {
      setServiceStatus({
        service: 'jellyfin-file-manager',
        status: 'offline',
      });
    }
  };

  const fetchRootPath = async () => {
    try {
      const payload = await callJson('/api/files/root');
      setBasePath(payload.basePath || '/mnt');
    } catch (error) {
      showNotification('error', error.message);
    }
  };

  const fetchProxyStatus = async () => {
    try {
      const response = await fetch('/api/proxy/status');
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load proxy status');
      }

      applyProxyStatus(payload, {
        port: 3001,
      });
    } catch (_) {
      setProxyStatus((current) => ({
        ...current,
        state: 'offline',
        running: false,
        starting: false,
      }));
    }
  };

  const fetchWhitelist = async ({ silent = false } = {}) => {
    try {
      const payload = await callJson('/api/proxy/whitelist');
      setWhitelistEntries(Array.isArray(payload.entries) ? payload.entries : []);
      applyProxyStatus(payload);
    } catch (error) {
      if (!silent) {
        showNotification('error', error.message);
      }
    }
  };

  const fetchLogFilters = async ({ silent = false } = {}) => {
    if (!silent) {
      setLogFilterLoading(true);
    }

    try {
      const payload = await callJson('/api/proxy/log-filters');
      setLogFilterEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setLogFilterCounts(payload.counts && typeof payload.counts === 'object' ? payload.counts : {});
      applyProxyStatus(payload);
    } catch (error) {
      if (!silent) {
        showNotification('error', error.message);
      }
    } finally {
      if (!silent) {
        setLogFilterLoading(false);
      }
    }
  };

  const fetchProxyLogs = async ({ silent = false } = {}) => {
    if (!silent) {
      setProxyLogsLoading(true);
    }

    try {
      const payload = await callJson('/api/proxy/logs?limit=500');
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      setProxyLogs(entries);
      applyProxyStatus(payload);
    } catch (error) {
      if (!silent) {
        showNotification('error', error.message);
      }
    } finally {
      if (!silent) {
        setProxyLogsLoading(false);
      }
    }
  };

  const handleRefreshProxyLogs = async () => {
    await fetchLogFilters({ silent: true });
    await fetchProxyLogs();
  };

  useEffect(() => {
    document.title = isProxyPage ? 'Proxy Manager' : '/mnt File Manager';
    fetchAuthStatus();
    fetchServiceStatus();
    fetchProxyStatus();

    if (isProxyPage) {
      fetchWhitelist();
      fetchLogFilters();
      fetchProxyLogs();
    } else {
      fetchDirectory('');
      fetchRootPath();
    }
  }, []);

  const handlePasswordSetupSubmit = async (event) => {
    event.preventDefault();

    if (!passwordSetupPassword.trim()) {
      showNotification('error', 'Enter a new password first');
      return;
    }

    if (passwordSetupPassword !== passwordSetupConfirm) {
      showNotification('error', 'The new password and confirmation do not match');
      return;
    }

    setPasswordSetupSubmitting(true);
    try {
      const payload = await callJson('/api/auth/bootstrap-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: passwordSetupPassword,
          confirmPassword: passwordSetupConfirm,
        }),
      });

      setPasswordSetupRequired(false);
      setPasswordSetupPassword('');
      setPasswordSetupConfirm('');
      showNotification('success', payload.message || 'Password updated');

      if (payload.reauthenticate) {
        window.setTimeout(() => {
          window.location.reload();
        }, 500);
      }
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setPasswordSetupSubmitting(false);
    }
  };

  useEffect(() => {
    if (!isProxyPage) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      fetchProxyStatus();
      fetchWhitelist({ silent: true });
      fetchLogFilters({ silent: true });
      fetchProxyLogs({ silent: true });
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [isProxyPage]);

  useEffect(() => {
    if (isProxyPage) {
      return undefined;
    }

    const handler = (event) => {
      if (!tableRef.current) return;

      if (event.key === 'Backspace' && parentPath !== null && !actionLoading) {
        const target = event.target;
        if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
        event.preventDefault();
        openFolder(parentPath || '');
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isProxyPage, parentPath, actionLoading]);

  useEffect(() => {
    if (renameAssistantOpen && renamePanelRef.current) {
      renamePanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [renameAssistantOpen, scanLoading]);

  useEffect(() => {
    if (!logEntryModalOpen) {
      return undefined;
    }

    const handleEscape = (event) => {
      if (event.key === 'Escape' && !logEntrySubmitting) {
        setLogEntryModalOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [logEntryModalOpen, logEntrySubmitting]);

  useEffect(() => {
    if (isProxyPage) {
      return undefined;
    }

    const handlePointerMove = (event) => {
      const dragState = floatingToolsDragRef.current;
      if (!dragState) {
        return;
      }

      const maxX = Math.max(window.innerWidth - dragState.width - 12, 12);
      const maxY = Math.max(window.innerHeight - dragState.height - 12, 12);
      const nextX = Math.min(Math.max(dragState.originX + event.clientX - dragState.startX, 12), maxX);
      const nextY = Math.min(Math.max(dragState.originY + event.clientY - dragState.startY, 12), maxY);

      setFloatingToolsPosition({ x: nextX, y: nextY });
    };

    const handlePointerUp = () => {
      floatingToolsDragRef.current = null;
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    };
  }, [isProxyPage]);

  const sortedItems = useMemo(() => {
    const sorted = [...items];
    sorted.sort((left, right) => {
      let comparison = 0;

      if (sortKey === 'name' || sortKey === 'type') {
        comparison = String(left[sortKey]).localeCompare(String(right[sortKey]));
      } else if (sortKey === 'size') {
        comparison = left.size - right.size;
      } else if (sortKey === 'modified') {
        comparison = new Date(left.modified) - new Date(right.modified);
      }

      if (sortKey !== 'type' && left.type !== right.type) {
        comparison = left.type === 'folder' ? -1 : 1;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [items, sortDirection, sortKey]);

  const setSort = (key) => {
    if (sortKey === key) {
      setSortDirection((value) => (value === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortKey(key);
    setSortDirection(key === 'modified' ? 'desc' : 'asc');
  };

  const openFolder = async (path) => {
    await fetchDirectory(path, search);
  };

  const withAction = async (callback, successMessage) => {
    setActionLoading(true);
    try {
      await callback();
      if (successMessage) {
        showNotification('success', successMessage);
      }
      await fetchDirectory(currentPath, search);
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateFolder = async () => {
    const name = window.prompt('New folder name');
    if (!name) return;

    await withAction(
      () =>
        callJson('/api/files/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentPath, name }),
        }),
      'Folder created'
    );
  };

  const handleRename = async (item) => {
    const newName = window.prompt(`Rename ${item.name} to`, item.name);
    if (!newName || newName === item.name) return;

    await withAction(
      () =>
        callJson('/api/files/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: item.path, newName }),
        }),
      'Rename complete'
    );
  };

  const handleDelete = async (item) => {
    const confirmed = window.confirm(
      item.type === 'folder'
        ? `Delete folder "${item.name}" and all of its contents?`
        : `Delete file "${item.name}"?`
    );

    if (!confirmed) return;

    await withAction(
      () =>
        callJson('/api/files', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: item.path }),
        }),
      `${item.type === 'folder' ? 'Folder' : 'File'} deleted`
    );
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', currentPath);

    await withAction(async () => {
      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Upload failed');
      }
    }, 'File uploaded');

    event.target.value = '';
  };

  const handleUpdatePackage = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const confirmed = window.confirm(
      'Upload this zip, overwrite files in /home/user/jellyfin-file-manager, and restart the jellyfin-file-manager service?'
    );

    if (!confirmed) {
      event.target.value = '';
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setUpdateLoading(true);
    try {
      const response = await fetch('/api/files/app-update', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || 'App update failed');
      }

      showNotification('success', payload.message || 'Application updated successfully');
      await fetchServiceStatus();
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setUpdateLoading(false);
      event.target.value = '';
    }
  };

  const handleDownload = (item) => {
    window.location.href = `/api/files/download?path=${encodeURIComponent(item.path)}`;
  };

  const handleShow = (item) => {
    window.open(`/api/files/show?path=${encodeURIComponent(item.path)}`, '_blank', 'noopener,noreferrer');
  };

  const handlePlay = (item) => {
    setPlayerItem(item);
  };

  const handleSearchSubmit = async (event) => {
    event.preventDefault();
    await fetchDirectory(currentPath, search);
  };

  const handleScrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  const handleFloatingToolsDragStart = (event) => {
    if (event.button !== 0 || !floatingToolsRef.current) {
      return;
    }

    const bounds = floatingToolsRef.current.getBoundingClientRect();
    floatingToolsDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: floatingToolsPosition.x,
      originY: floatingToolsPosition.y,
      width: bounds.width,
      height: bounds.height,
    };

    event.preventDefault();
  };

  const handleChangeRootPath = async () => {
    const nextPath = window.prompt('Set a new absolute root folder path', basePath);
    if (!nextPath || nextPath === basePath) return;

    setRootPathLoading(true);
    try {
      const payload = await callJson('/api/files/root', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: nextPath }),
      });

      setBasePath(payload.basePath || nextPath);
      setCurrentPath(payload.currentPath || '');
      setParentPath(payload.parentPath ?? null);
      setItems(payload.items || []);
      setStats(payload.stats || { fileCount: 0, folderCount: 0, totalSize: 0 });
      setSearch('');
      showNotification('success', payload.message || 'Root folder updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setRootPathLoading(false);
    }
  };

  const handleToggleProxy = async () => {
    setProxyLoading(true);
    try {
      const endpoint = proxyStatus.running ? '/api/proxy/stop' : '/api/proxy/start';
      const payload = await callJson(endpoint, {
        method: 'POST',
      });

      applyProxyStatus(payload);
      showNotification('success', payload.message || (proxyStatus.running ? 'Proxy stopped' : 'Proxy started'));

      if (isProxyPage) {
        await fetchProxyLogs({ silent: true });
      }
    } catch (error) {
      showNotification('error', error.message);
      fetchProxyStatus();
    } finally {
      setProxyLoading(false);
    }
  };

  const handleWhitelistSubmit = async (event) => {
    event.preventDefault();
    if (!whitelistInput.trim()) {
      showNotification('error', whitelistInputIsRegex ? 'Enter a regex pattern to whitelist' : 'Enter a URL or hostname to whitelist');
      return;
    }

    setWhitelistSubmitting(true);
    try {
      const payload = await callJson('/api/proxy/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: whitelistInput, isRegex: whitelistInputIsRegex }),
      });

      setWhitelistEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setSelectedWhitelistEntries([]);
      applyProxyStatus(payload);
      setWhitelistInput('');
      setWhitelistInputIsRegex(false);
      showNotification('success', payload.message || 'Whitelist updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setWhitelistSubmitting(false);
    }
  };

  const handleWhitelistEditStart = (entry) => {
    setEditingWhitelistEntry(getManagedEntryKey(entry));
    setEditingWhitelistValue(entry.value);
    setEditingWhitelistIsRegex(Boolean(entry.isRegex));
  };

  const handleWhitelistEditCancel = () => {
    setEditingWhitelistEntry('');
    setEditingWhitelistValue('');
    setEditingWhitelistIsRegex(false);
  };

  const handleWhitelistEditSave = async (entry) => {
    if (!editingWhitelistValue.trim()) {
      showNotification('error', editingWhitelistIsRegex ? 'Enter a regex pattern to save' : 'Enter a URL or hostname to save');
      return;
    }

    setWhitelistSubmitting(true);
    try {
      const payload = await callJson('/api/proxy/whitelist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentValue: entry.value,
          currentIsRegex: Boolean(entry.isRegex),
          newValue: editingWhitelistValue,
          isRegex: editingWhitelistIsRegex,
        }),
      });

      setWhitelistEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setSelectedWhitelistEntries([]);
      applyProxyStatus(payload);
      setEditingWhitelistEntry('');
      setEditingWhitelistValue('');
      setEditingWhitelistIsRegex(false);
      showNotification('success', payload.message || 'Whitelist updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setWhitelistSubmitting(false);
    }
  };

  const handleClearProxyLogs = async () => {
    setClearLogsLoading(true);
    try {
      await callJson('/api/proxy/clear-logs', {
        method: 'POST',
      });
      setProxyLogs([]);
      showNotification('success', 'Proxy logs cleared');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setClearLogsLoading(false);
    }
  };

  const handleCopyProxyLogs = async () => {
    setCopyLogsLoading(true);
    try {
      const contents = proxyLogs.map((entry) => stripLogTimestamp(entry)).join('\n');
      await copyText(contents);
      showNotification('success', 'Proxy logs copied');
    } catch (error) {
      showNotification('error', error.message || 'Failed to copy proxy logs');
    } finally {
      setCopyLogsLoading(false);
    }
  };

  const handleOpenLogEntryModal = (entry) => {
    setLogEntryValue(extractUrlFromLogEntry(entry));
    setLogEntryMode('hide');
    setLogEntryIsRegex(false);
    setLogEntryModalOpen(true);
  };

  const handleSubmitLogEntryModal = async () => {
    const value = logEntryValue.trim();
    if (!value) {
      showNotification('error', logEntryIsRegex ? 'Enter a regex pattern first' : 'Enter a URL or hostname first');
      return;
    }

    const isHideMode = logEntryMode === 'hide';
    const endpoint = isHideMode ? '/api/proxy/log-filters' : '/api/proxy/whitelist';

    setLogEntrySubmitting(true);
    try {
      const payload = await callJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, isRegex: logEntryIsRegex }),
      });

      if (isHideMode) {
        setLogFilterEntries(Array.isArray(payload.entries) ? payload.entries : []);
        setLogFilterCounts(payload.counts && typeof payload.counts === 'object' ? payload.counts : {});
        setSelectedLogFilterEntries([]);
        await fetchProxyLogs({ silent: true });
      } else {
        setWhitelistEntries(Array.isArray(payload.entries) ? payload.entries : []);
        setSelectedWhitelistEntries([]);
      }

      applyProxyStatus(payload);
      setLogEntryModalOpen(false);
      setLogEntryValue('');
      showNotification('success', payload.message || (isHideMode ? 'Added to log filter' : 'Added to whitelist'));
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setLogEntrySubmitting(false);
    }
  };

  const handleLogFilterSubmit = async (event) => {
    event.preventDefault();
    if (!logFilterInput.trim()) {
      showNotification('error', logFilterInputIsRegex ? 'Enter a regex pattern to hide from the log' : 'Enter a URL or hostname to hide from the log');
      return;
    }

    setLogFilterSubmitting(true);
    try {
      const payload = await callJson('/api/proxy/log-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: logFilterInput, isRegex: logFilterInputIsRegex }),
      });

      setLogFilterEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setLogFilterCounts(payload.counts && typeof payload.counts === 'object' ? payload.counts : {});
      setSelectedLogFilterEntries([]);
      applyProxyStatus(payload);
      setLogFilterInput('');
      setLogFilterInputIsRegex(false);
      await fetchProxyLogs({ silent: true });
      showNotification('success', payload.message || 'Log filter updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setLogFilterSubmitting(false);
    }
  };

  const handleLogFilterEditStart = (entry) => {
    setEditingLogFilterEntry(getManagedEntryKey(entry));
    setEditingLogFilterValue(entry.value);
    setEditingLogFilterIsRegex(Boolean(entry.isRegex));
  };

  const handleLogFilterEditCancel = () => {
    setEditingLogFilterEntry('');
    setEditingLogFilterValue('');
    setEditingLogFilterIsRegex(false);
  };

  const handleLogFilterEditSave = async (entry) => {
    if (!editingLogFilterValue.trim()) {
      showNotification('error', editingLogFilterIsRegex ? 'Enter a regex pattern to save' : 'Enter a URL or hostname to save');
      return;
    }

    setLogFilterSubmitting(true);
    try {
      const payload = await callJson('/api/proxy/log-filters', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentValue: entry.value,
          currentIsRegex: Boolean(entry.isRegex),
          newValue: editingLogFilterValue,
          isRegex: editingLogFilterIsRegex,
        }),
      });

      setLogFilterEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setLogFilterCounts(payload.counts && typeof payload.counts === 'object' ? payload.counts : {});
      setSelectedLogFilterEntries([]);
      applyProxyStatus(payload);
      setEditingLogFilterEntry('');
      setEditingLogFilterValue('');
      setEditingLogFilterIsRegex(false);
      await fetchProxyLogs({ silent: true });
      showNotification('success', payload.message || 'Log filter updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setLogFilterSubmitting(false);
    }
  };

  const handleScanMediaFiles = async () => {
    setScanLoading(true);
    setRenameAssistantOpen(true);

    try {
      const payload = await callJson('/api/files/media-rename/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      setRenameSuggestions(
        payload.suggestions.map((item) => ({
          ...item,
          editedVideoName: item.video.suggestedName,
          editedSubtitleName: item.subtitle.suggestedName,
        }))
      );
      setActiveRenameIndex(0);

      if (!payload.count) {
        showNotification('success', 'No matching MP4/SRT rename suggestions were found');
      }
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setScanLoading(false);
    }
  };

  const handleRootShortcut = async () => {
    if (!currentPath) {
      await handleChangeRootPath();
      return;
    }

    await openFolder('');
  };

  const updateRenameSuggestion = (videoPath, field, value) => {
    setRenameSuggestions((current) =>
      current.map((item) =>
        item.video.path === videoPath
          ? {
              ...item,
              [field]: value,
            }
          : item
      )
    );
  };

  const closeRenameAssistant = () => {
    setRenameAssistantOpen(false);
    setActiveRenameIndex(0);
  };

  const advanceRenameAssistant = (currentSuggestions, currentIndex) => {
    const nextSuggestions = currentSuggestions.filter((_, index) => index !== currentIndex);

    if (!nextSuggestions.length) {
      setRenameSuggestions([]);
      closeRenameAssistant();
      showNotification('success', 'Subtitle rename review complete');
      return;
    }

    setRenameSuggestions(nextSuggestions);
    setActiveRenameIndex(Math.min(currentIndex, nextSuggestions.length - 1));
  };

  const handleSkipRenameSuggestion = () => {
    advanceRenameAssistant(renameSuggestions, activeRenameIndex);
  };

  const handleApplyCurrentRenameSuggestion = async () => {
    const currentSuggestion = renameSuggestions[activeRenameIndex];
    if (!currentSuggestion) return;

    const newVideoName = currentSuggestion.editedVideoName.trim();
    const newSubtitleName = currentSuggestion.editedSubtitleName.trim();

    if (!newVideoName || !newSubtitleName) {
      showNotification('error', 'The MP4 and SRT names cannot be empty');
      return;
    }

    const renames = [
      {
        path: currentSuggestion.video.path,
        newName: newVideoName,
      },
      {
        path: currentSuggestion.subtitle.path,
        newName: newSubtitleName,
      },
    ].filter((item, index) =>
      index === 0
        ? item.newName !== currentSuggestion.video.oldName
        : item.newName !== currentSuggestion.subtitle.oldName
    );

    if (!renames.length) {
      advanceRenameAssistant(renameSuggestions, activeRenameIndex);
      return;
    }

    setActionLoading(true);
    try {
      await callJson('/api/files/media-rename/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ renames }),
      });

      showNotification('success', 'Pair renamed');
      advanceRenameAssistant(renameSuggestions, activeRenameIndex);
      await fetchDirectory(currentPath, search);
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const currentRenameSuggestion = renameSuggestions[activeRenameIndex] || null;
  const remainingRenameCount = renameSuggestions.length;

  const handleWhitelistSelectionToggle = (entry) => {
    const entryKey = getManagedEntryKey(entry);
    setSelectedWhitelistEntries((current) =>
      current.includes(entryKey) ? current.filter((value) => value !== entryKey) : current.concat(entryKey)
    );
  };

  const handleWhitelistBulkDelete = async () => {
    if (!selectedWhitelistEntries.length) {
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedWhitelistEntries.length} whitelist entr${selectedWhitelistEntries.length === 1 ? 'y' : 'ies'}?`);
    if (!confirmed) {
      return;
    }

    setRemovingWhitelistEntry('__bulk__');
    try {
      for (const entryKey of selectedWhitelistEntries) {
        const entry = whitelistEntries.find((item) => getManagedEntryKey(item) === entryKey);
        if (!entry) {
          continue;
        }
        const payload = await callJson('/api/proxy/whitelist', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: entry.value, isRegex: Boolean(entry.isRegex) }),
        });

        setWhitelistEntries(Array.isArray(payload.entries) ? payload.entries : []);
        applyProxyStatus(payload);
      }

      setSelectedWhitelistEntries([]);
      if (editingWhitelistEntry && selectedWhitelistEntries.includes(editingWhitelistEntry)) {
        setEditingWhitelistEntry('');
        setEditingWhitelistValue('');
        setEditingWhitelistIsRegex(false);
      }
      showNotification('success', 'Whitelist updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setRemovingWhitelistEntry('');
    }
  };

  const handleLogFilterSelectionToggle = (entry) => {
    const entryKey = getManagedEntryKey(entry);
    setSelectedLogFilterEntries((current) =>
      current.includes(entryKey) ? current.filter((value) => value !== entryKey) : current.concat(entryKey)
    );
  };

  const handleLogFilterBulkDelete = async () => {
    if (!selectedLogFilterEntries.length) {
      return;
    }

    setRemovingLogFilterEntry('__bulk__');
    try {
      for (const entryKey of selectedLogFilterEntries) {
        const entry = logFilterEntries.find((item) => getManagedEntryKey(item) === entryKey);
        if (!entry) {
          continue;
        }
        const payload = await callJson('/api/proxy/log-filters', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: entry.value, isRegex: Boolean(entry.isRegex) }),
        });

        setLogFilterEntries(Array.isArray(payload.entries) ? payload.entries : []);
        setLogFilterCounts(payload.counts && typeof payload.counts === 'object' ? payload.counts : {});
        applyProxyStatus(payload);
      }

      setSelectedLogFilterEntries([]);
      if (editingLogFilterEntry && selectedLogFilterEntries.includes(editingLogFilterEntry)) {
        setEditingLogFilterEntry('');
        setEditingLogFilterValue('');
        setEditingLogFilterIsRegex(false);
      }
      await fetchProxyLogs({ silent: true });
      showNotification('success', 'Log filter updated');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setRemovingLogFilterEntry('');
    }
  };

  const handleResetLogFilterCounts = async () => {
    setResetLogFilterCountsLoading(true);
    try {
      const payload = await callJson('/api/proxy/log-filters/reset-counts', {
        method: 'POST',
      });

      setLogFilterEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setLogFilterCounts(payload.counts && typeof payload.counts === 'object' ? payload.counts : {});
      applyProxyStatus(payload);
      await fetchProxyLogs({ silent: true });
      showNotification('success', payload.message || 'Log filter counters reset');
    } catch (error) {
      showNotification('error', error.message);
    } finally {
      setResetLogFilterCountsLoading(false);
    }
  };

  const renderPageTabs = () => (
    <header className="top-row page-header">
      <nav className="page-switcher" aria-label="Primary navigation">
        <a className={`page-link ${!isProxyPage ? 'active' : ''}`} href="/">
          <span className={`nav-status-dot ${serviceStatus.status}`}></span>
          File Manager
        </a>
        <span className="page-switch-separator" aria-hidden="true">
          |
        </span>
        <a className={`page-link ${isProxyPage ? 'active' : ''}`} href="/proxy">
          <span className={`nav-status-dot ${proxyStatus.state}`}></span>
          Proxy Manager
        </a>
      </nav>

      <div className="menu-box header-actions">
        {isProxyPage ? (
          <>
            <button
              className={`button header-action-button ${proxyStatus.running ? 'danger-outline' : 'secondary'}`}
              type="button"
              onClick={handleToggleProxy}
              disabled={proxyLoading || proxyStatus.starting}
            >
              {proxyLoading || proxyStatus.starting ? 'Working...' : proxyStatus.running ? 'Stop Proxy' : 'Start Proxy'}
            </button>
            <a
              className="button subtle-button icon-button header-icon-link"
              href="/api/proxy/ca-cert"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Download Proxy CA"
              title="Download Proxy CA"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 3.5 4.5 6.8v5.1c0 4.5 2.8 8.1 7.5 9.8 4.7-1.7 7.5-5.3 7.5-9.8V6.8z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="M12 9.5v5M9.5 12h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </a>
            <a
              className="button subtle-button icon-button header-icon-link"
              href="http://192.168.1.108:9091/transmission/web/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Transmission"
              title="Transmission"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4v12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <path d="m8.5 8.5 3.5-3.5 3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M6 20h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </a>
          </>
        ) : (
          <button
            className="version-button header-action-button"
            type="button"
            onClick={() => updateInputRef.current?.click()}
            disabled={actionLoading || updateLoading}
            title="Upload update package"
          >
            {updateLoading ? 'Updating...' : `Version ${APP_VERSION}`}
          </button>
        )}
      </div>
    </header>
  );

  const renderFilePage = () => (
    <>
      {!isProxyPage && (
        <div
          ref={floatingToolsRef}
          className="floating-tools glass-panel"
          style={{ left: `${floatingToolsPosition.x}px`, top: `${floatingToolsPosition.y}px` }}
        >
          <button
            className="floating-tools-grip"
            type="button"
            onMouseDown={handleFloatingToolsDragStart}
            aria-label="Move floating tools"
            title="Drag to move"
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
          <button
            className="floating-tool-button"
            type="button"
            onClick={handleRootShortcut}
            disabled={loading || rootPathLoading || actionLoading}
            aria-label={currentPath ? 'Go to root folder' : 'Change root folder'}
            title={currentPath ? 'Go to root folder' : 'Change root folder'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 11.5 12 5l8 6.5v7A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path d="M9.5 20v-4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V20" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
          <button
            className="floating-tool-button"
            type="button"
            onClick={() => openFolder(parentPath || '')}
            disabled={parentPath === null || loading}
            aria-label="Go up one folder"
            title="Folder up"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5l-6 6h4v8h4v-8h4z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="floating-tool-button"
            type="button"
            onClick={handleCreateFolder}
            disabled={actionLoading}
            aria-label="Create new folder"
            title="New folder"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h6l2 2h8v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="currentColor" opacity="0.7" />
              <path d="M12 10v6M9 13h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="floating-tool-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={actionLoading}
            aria-label="Upload file"
            title="Upload file"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 4l4.5 4.5-1.4 1.4-2.1-2.1V16h-2V7.8L8.9 9.9 7.5 8.5z" fill="currentColor" />
              <path d="M6 18h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            className="floating-tool-button"
            type="button"
            onClick={handleScrollToTop}
            aria-label="Scroll to top"
            title="Scroll to top"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5l-6 6h4v8h4v-8h4z" fill="currentColor" />
              <path d="M6 6h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}

      <input
        ref={updateInputRef}
        className="hidden-input"
        type="file"
        onChange={handleUpdatePackage}
        accept=".zip,application/zip"
      />
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        onChange={handleUpload}
        accept="*/*"
      />

      <section className="glass-panel toolbar">
        <form className="search-form search-form-top" onSubmit={handleSearchSubmit}>
          <input
            type="search"
            placeholder="Search current folder"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button className="button secondary" type="submit" disabled={loading}>
            Search
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={handleScanMediaFiles}
            disabled={scanLoading || actionLoading}
            title="Scan and review MP4/SRT rename suggestions"
          >
            {scanLoading ? 'Scanning...' : 'Auto Rename'}
          </button>
        </form>

        <div className="breadcrumb">
          <span>Current:</span>
          <code>{currentPath ? `${basePath}/${currentPath}` : basePath}</code>
        </div>
      </section>

      <section className="stats-grid">
        <article className="glass-panel stat-card">
          <span>Folders</span>
          <strong>{stats.folderCount}</strong>
        </article>
        <article className="glass-panel stat-card">
          <span>Files</span>
          <strong>{stats.fileCount}</strong>
        </article>
        <article className="glass-panel stat-card">
          <span>Total Size</span>
          <strong>{formatBytes(stats.totalSize)}</strong>
        </article>
      </section>

      <section className="glass-panel table-panel">
        {notification && <div className={`notice ${notification.type}`}>{notification.message}</div>}

        {loading ? (
          <div className="empty-state">Loading directory...</div>
        ) : sortedItems.length === 0 ? (
          <div className="empty-state">No items found in this folder.</div>
        ) : (
          <div className="table-wrap" tabIndex="0" ref={tableRef}>
            <table className="file-table">
              <thead>
                <tr>
                  <th>
                    <button className="sort-button" type="button" onClick={() => setSort('name')}>
                      Name
                    </button>
                  </th>
                  <th>
                    <button className="sort-button" type="button" onClick={() => setSort('type')}>
                      Type
                    </button>
                  </th>
                  <th>
                    <button className="sort-button" type="button" onClick={() => setSort('size')}>
                      Size
                    </button>
                  </th>
                  <th>
                    <button className="sort-button" type="button" onClick={() => setSort('modified')}>
                      Modified
                    </button>
                  </th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr
                    key={item.path}
                    className={item.type === 'folder' ? 'clickable-row' : ''}
                    onClick={item.type === 'folder' ? () => openFolder(item.path) : undefined}
                  >
                    <td className="name-cell">
                      <span className={`item-icon ${item.type}`}>{item.type === 'folder' ? '[DIR]' : '[FILE]'}</span>
                      {item.type === 'folder' ? (
                        <button
                          className="name-link"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openFolder(item.path);
                          }}
                        >
                          {item.name}
                        </button>
                      ) : (
                        <span>{item.name}</span>
                      )}
                    </td>
                    <td>{item.type}</td>
                    <td>{item.type === 'folder' ? '-' : formatBytes(item.size)}</td>
                    <td>{formatDate(item.modified)}</td>
                    <td>
                      <div className="action-group">
                        {((item.type === 'file' && isVideoFile(item.name)) || item.playableItem?.path) ? (
                          <button
                            className="button inline secondary-inline"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handlePlay(item.playableItem || item);
                            }}
                          >
                            Play
                          </button>
                        ) : null}
                        {item.type === 'file' ? (
                          <button
                            className="button inline secondary-inline"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleShow(item);
                            }}
                          >
                            {isSubtitleFile(item.name) ? 'View Text' : 'Show'}
                          </button>
                        ) : null}
                        {item.type === 'file' && !isSubtitleFile(item.name) ? (
                          <button
                            className="button inline"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDownload(item);
                            }}
                          >
                            Download
                          </button>
                        ) : null}
                        <button
                          className="button inline"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRename(item);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="button inline danger"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleDelete(item);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );

  const renderProxyPage = () => (
    <>
      <section className="proxy-overview-grid">
        <article className="glass-panel stat-card">
          <span>Whitelist Hosts</span>
          <strong>{whitelistEntries.length}</strong>
        </article>
        <article className="glass-panel stat-card">
          <span>Live Log Lines</span>
          <strong>{proxyLogs.length}</strong>
        </article>
        <article className="glass-panel stat-card">
          <span>Started</span>
          <strong>{proxyStatus.startedAt ? formatDate(proxyStatus.startedAt) : '-'}</strong>
        </article>
      </section>

      {notification && <div className={`notice ${notification.type}`}>{notification.message}</div>}

      {logEntryModalOpen && (
        <div className="rename-modal-backdrop" onClick={() => !logEntrySubmitting && setLogEntryModalOpen(false)}>
          <section className="glass-panel proxy-entry-modal" onClick={(event) => event.stopPropagation()}>
            <div className="proxy-entry-modal-header">
              <div>
                <p className="eyebrow">Add from log row</p>
                <h2>Review entry</h2>
                <p className="subtle">Edit the URL/host and choose where to add it.</p>
              </div>
              <button
                className="button subtle-button"
                type="button"
                onClick={() => setLogEntryModalOpen(false)}
                disabled={logEntrySubmitting}
              >
                Close
              </button>
            </div>

            <label className="rename-field">
              <span>{logEntryIsRegex ? 'Regex pattern' : 'URL or hostname'}</span>
              <input
                type="text"
                value={logEntryValue}
                onChange={(event) => setLogEntryValue(event.target.value)}
                disabled={logEntrySubmitting}
                placeholder={logEntryIsRegex ? '^(.+\\.)?example\\.com$' : 'https://example.com/path or example.com'}
                autoFocus
              />
            </label>

            <label className="managed-entry-toggle">
              <input
                type="checkbox"
                checked={logEntryIsRegex}
                onChange={(event) => setLogEntryIsRegex(event.target.checked)}
                disabled={logEntrySubmitting}
              />
              <span>Regex</span>
            </label>

            <div className="proxy-entry-mode-switch" role="group" aria-label="Target list">
              <button
                className={`button ${logEntryMode === 'hide' ? 'primary' : 'secondary'}`}
                type="button"
                onClick={() => setLogEntryMode('hide')}
                disabled={logEntrySubmitting}
              >
                Hide
              </button>
              <button
                className={`button ${logEntryMode === 'allow' ? 'primary' : 'secondary'}`}
                type="button"
                onClick={() => setLogEntryMode('allow')}
                disabled={logEntrySubmitting}
              >
                Allow
              </button>
            </div>

            <div className="rename-actions">
              <button
                className="button subtle-button"
                type="button"
                onClick={() => setLogEntryModalOpen(false)}
                disabled={logEntrySubmitting}
              >
                Cancel
              </button>
              <button className="button primary" type="button" onClick={handleSubmitLogEntryModal} disabled={logEntrySubmitting}>
                {logEntrySubmitting
                  ? 'Saving...'
                  : logEntryMode === 'hide'
                    ? 'Add to Log filter'
                    : 'Add to Whitelist'}
              </button>
            </div>
          </section>
        </div>
      )}

      <section className="proxy-layout">
        <section className="glass-panel proxy-log-panel proxy-log-panel-wide">
          <div className="proxy-section-header">
            <div>
              <p className="eyebrow">Live Activity</p>
            </div>
            <div className="proxy-section-actions">
              <button
                className="button subtle-button icon-button"
                type="button"
                onClick={handleRefreshProxyLogs}
                disabled={proxyLogsLoading}
                aria-label="Refresh logs"
                title="Refresh logs"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M7 7.5H3.5V4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4 7.5A8 8 0 1 1 8.6 19"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <a
                className="button subtle-button icon-button"
                href="/api/proxy/logs/text"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View log file"
                title="View log file"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M7 3.5h7l4.5 4.5V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5.5 20V5A1.5 1.5 0 0 1 7 3.5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path d="M14 3.5V8h4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M9 12h6M9 15h6M9 18h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </a>
              <button
                className="button subtle-button icon-button"
                type="button"
                onClick={handleCopyProxyLogs}
                disabled={copyLogsLoading || proxyLogs.length === 0}
                aria-label="Copy logs"
                title="Copy logs"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9 9.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 17 20.5H9A1.5 1.5 0 0 1 7.5 19v-8A1.5 1.5 0 0 1 9 9.5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M6 14.5H5A1.5 1.5 0 0 1 3.5 13V5A1.5 1.5 0 0 1 5 3.5h8A1.5 1.5 0 0 1 14.5 5v1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className="button subtle-button icon-button"
                type="button"
                onClick={handleClearProxyLogs}
                disabled={clearLogsLoading}
                aria-label="Clear logs"
                title="Clear logs"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M6 7h12M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m-7.5 0 .8 11a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4L16.5 7M10 10.5v5M14 10.5v5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          </div>
          {proxyLogsLoading && proxyLogs.length === 0 ? (
            <div className="empty-state">Loading proxy logs...</div>
          ) : proxyLogs.length === 0 ? (
            <div className="empty-state">No proxy events logged yet.</div>
          ) : (
            <div className="proxy-log-box" ref={logBoxRef} aria-live="polite">
              {proxyLogs.map((entry, index) => (
                <button
                  className="proxy-log-line proxy-log-line-button"
                  type="button"
                  key={`${index}-${entry}`}
                  onClick={() => handleOpenLogEntryModal(entry)}
                  title="Add this row to Log filter or Whitelist"
                >
                  {truncateLogLine(entry)}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="glass-panel whitelist-panel">
            <div className="whitelist-header">
              <div>
                <p className="eyebrow">Whitelist</p>
              </div>
            <div className="whitelist-list-toolbar">
              <span>{whitelistEntries.length}</span>
              <button
                className="button secondary"
                type="button"
                onClick={handleWhitelistBulkDelete}
                disabled={!selectedWhitelistEntries.length || removingWhitelistEntry === '__bulk__'}
              >
                {removingWhitelistEntry === '__bulk__'
                  ? 'Deleting...'
                  : `Delete Selected${selectedWhitelistEntries.length ? ` (${selectedWhitelistEntries.length})` : ''}`}
              </button>
            </div>
            </div>

            <form className="whitelist-form" onSubmit={handleWhitelistSubmit}>
              <input
                type="text"
                placeholder={whitelistInputIsRegex ? '^(.+\\.)?example\\.com$' : 'https://example.com/path or example.com'}
                value={whitelistInput}
                onChange={(event) => setWhitelistInput(event.target.value)}
                disabled={whitelistSubmitting}
              />
              <label className="managed-entry-toggle">
                <input
                  type="checkbox"
                  checked={whitelistInputIsRegex}
                  onChange={(event) => setWhitelistInputIsRegex(event.target.checked)}
                  disabled={whitelistSubmitting}
                />
                <span>Regex</span>
              </label>
              <button className="button primary" type="submit" disabled={whitelistSubmitting}>
                {whitelistSubmitting ? 'Saving...' : 'Add Host'}
              </button>
            </form>

            <div className="whitelist-group">
              {whitelistEntries.length === 0 ? (
                <div className="empty-state">No whitelist entries yet.</div>
              ) : (
                <div className="whitelist-list">
                  {whitelistEntries.map((entry) => (
                    <div className="whitelist-row" key={getManagedEntryKey(entry)}>
                      <label className="whitelist-select">
                        <input
                          type="checkbox"
                          checked={selectedWhitelistEntries.includes(getManagedEntryKey(entry))}
                          onChange={() => handleWhitelistSelectionToggle(entry)}
                        />
                      </label>
                      {editingWhitelistEntry === getManagedEntryKey(entry) ? (
                        <div className="managed-entry-edit">
                          <input
                            type="text"
                            value={editingWhitelistValue}
                            onChange={(event) => setEditingWhitelistValue(event.target.value)}
                            className="whitelist-edit-input"
                          />
                          <label className="managed-entry-toggle inline">
                            <input
                              type="checkbox"
                              checked={editingWhitelistIsRegex}
                              onChange={(event) => setEditingWhitelistIsRegex(event.target.checked)}
                              disabled={whitelistSubmitting}
                            />
                            <span>Regex</span>
                          </label>
                        </div>
                      ) : (
                        <button
                          className="whitelist-entry-button"
                          type="button"
                          onClick={() => handleWhitelistEditStart(entry)}
                        >
                          {getManagedEntryLabel(entry)}
                        </button>
                      )}
                      <div className="whitelist-actions">
                        {entry.isRegex ? <span className="whitelist-type-badge">Regex</span> : null}
                        {editingWhitelistEntry === getManagedEntryKey(entry) ? (
                          <>
                            <button
                              className="button inline"
                              type="button"
                              onClick={() => handleWhitelistEditSave(entry)}
                              disabled={whitelistSubmitting}
                            >
                              Save
                            </button>
                            <button className="button inline secondary-inline" type="button" onClick={handleWhitelistEditCancel}>
                              Cancel
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

        <section className="glass-panel whitelist-panel log-filter-panel">
            <div className="whitelist-header">
              <div>
                <p className="eyebrow">Log filter</p>
              </div>
              <div className="whitelist-list-toolbar">
                <span>{logFilterEntries.length}</span>
                <button
                  className="button subtle-button icon-button toolbar-icon-button"
                  type="button"
                  onClick={handleResetLogFilterCounts}
                  disabled={resetLogFilterCountsLoading}
                  aria-label="Reset hidden counters"
                  title="Reset hidden counters"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M7 7.5H3.5V4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M4 7.5A8 8 0 1 1 8.6 19"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={handleLogFilterBulkDelete}
                  disabled={
                    logFilterLoading ||
                    !selectedLogFilterEntries.length ||
                    removingLogFilterEntry === '__bulk__'
                  }
                >
                  {removingLogFilterEntry === '__bulk__'
                    ? 'Deleting...'
                    : `Delete Selected${selectedLogFilterEntries.length ? ` (${selectedLogFilterEntries.length})` : ''}`}
                </button>
              </div>
            </div>

            <form className="whitelist-form whitelist-form-inline" onSubmit={handleLogFilterSubmit}>
              <input
                type="text"
                placeholder={logFilterInputIsRegex ? '^(.+\\.)?example\\.com$' : 'https://example.com/path or example.com'}
                value={logFilterInput}
                onChange={(event) => setLogFilterInput(event.target.value)}
                disabled={logFilterSubmitting || logFilterLoading}
              />
              <label className="managed-entry-toggle">
                <input
                  type="checkbox"
                  checked={logFilterInputIsRegex}
                  onChange={(event) => setLogFilterInputIsRegex(event.target.checked)}
                  disabled={logFilterSubmitting || logFilterLoading}
                />
                <span>Regex</span>
              </label>
              <button className="button primary" type="submit" disabled={logFilterSubmitting || logFilterLoading}>
                {logFilterSubmitting ? 'Saving...' : logFilterLoading ? 'Loading...' : 'Add Host'}
              </button>
            </form>

            {logFilterLoading ? (
              <div className="empty-state">Loading log filter entries...</div>
            ) : logFilterEntries.length === 0 ? (
              <div className="empty-state">No log filter entries yet.</div>
            ) : (
              <div className="whitelist-list">
                {logFilterEntries.map((entry) => (
                  <div className="whitelist-row" key={getManagedEntryKey(entry)}>
                    <label className="whitelist-select">
                      <input
                        type="checkbox"
                        checked={selectedLogFilterEntries.includes(getManagedEntryKey(entry))}
                        onChange={() => handleLogFilterSelectionToggle(entry)}
                      />
                    </label>
                    {editingLogFilterEntry === getManagedEntryKey(entry) ? (
                      <div className="managed-entry-edit">
                        <input
                          type="text"
                          value={editingLogFilterValue}
                          onChange={(event) => setEditingLogFilterValue(event.target.value)}
                          className="whitelist-edit-input"
                        />
                        <label className="managed-entry-toggle inline">
                          <input
                            type="checkbox"
                            checked={editingLogFilterIsRegex}
                            onChange={(event) => setEditingLogFilterIsRegex(event.target.checked)}
                            disabled={logFilterSubmitting}
                          />
                          <span>Regex</span>
                        </label>
                      </div>
                    ) : (
                      <button
                        className="whitelist-entry-button"
                        type="button"
                        onClick={() => handleLogFilterEditStart(entry)}
                      >
                        {getManagedEntryLabel(entry)}
                      </button>
                    )}
                    <div className="whitelist-actions">
                      <span className="whitelist-count-badge">{Number(logFilterCounts[getManagedEntryKey(entry)] || 0)}</span>
                      {entry.isRegex ? <span className="whitelist-type-badge">Regex</span> : null}
                      {editingLogFilterEntry === getManagedEntryKey(entry) ? (
                        <>
                          <button
                            className="button inline"
                            type="button"
                            onClick={() => handleLogFilterEditSave(entry)}
                            disabled={logFilterSubmitting}
                          >
                            Save
                          </button>
                          <button className="button inline secondary-inline" type="button" onClick={handleLogFilterEditCancel}>
                            Cancel
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>
      </section>
    </>
  );

  return (
    <div className="shell">
      <div className="bg-orb orb-a"></div>
      <div className="bg-orb orb-b"></div>
      <div className="bg-orb orb-c"></div>

      <main className="dashboard">
        {renderPageTabs()}
        {isProxyPage ? renderProxyPage() : renderFilePage()}

        {renameAssistantOpen && (
          <div className="rename-modal-backdrop" onClick={() => !actionLoading && closeRenameAssistant()}>
            <section
              ref={renamePanelRef}
              className="glass-panel rename-panel rename-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="rename-panel-header">
                <div>
                  <p className="eyebrow">Batch rename review</p>
                  <h2>MP4 and SRT matching</h2>
                  <p className="subtle">
                    Review each suggested filename before applying changes across the library.
                  </p>
                </div>
                <button
                  className="button subtle-button"
                  type="button"
                  onClick={closeRenameAssistant}
                  disabled={actionLoading}
                >
                  Close
                </button>
              </div>

              {scanLoading ? (
                <div className="empty-state">Scanning all folders for MP4 and SRT pairs...</div>
              ) : !currentRenameSuggestion ? (
                <div className="empty-state">No editable rename suggestions are ready yet.</div>
              ) : (
                <>
                  <div className="rename-progress">
                    <span>{remainingRenameCount} pair{remainingRenameCount === 1 ? '' : 's'} left</span>
                  </div>
                  <div className="rename-review-list">
                    <article className="rename-card" key={currentRenameSuggestion.video.path}>
                      <div className="rename-meta">
                        <span className="rename-badge video">pair</span>
                        <code>
                          {currentRenameSuggestion.folderPath
                            ? `${basePath}/${currentRenameSuggestion.folderPath}`
                            : basePath}
                        </code>
                      </div>
                      <label className="rename-field">
                        <span>Current MP4</span>
                        <input type="text" value={currentRenameSuggestion.video.oldName} readOnly />
                      </label>
                      <label className="rename-field">
                        <span>Current SRT</span>
                        <input type="text" value={currentRenameSuggestion.subtitle.oldName} readOnly />
                      </label>
                      {currentRenameSuggestion.subtitle.folderPath !== currentRenameSuggestion.folderPath && (
                        <div className="rename-preview">
                          <span>
                            Subtitle folder:{' '}
                            {currentRenameSuggestion.subtitle.folderPath
                              ? `${basePath}/${currentRenameSuggestion.subtitle.folderPath}`
                              : basePath}
                          </span>
                        </div>
                      )}
                      <label className="rename-field">
                        <span>New MP4 name</span>
                        <input
                          type="text"
                          value={currentRenameSuggestion.editedVideoName}
                          onChange={(event) =>
                            updateRenameSuggestion(
                              currentRenameSuggestion.video.path,
                              'editedVideoName',
                              event.target.value
                            )
                          }
                        />
                      </label>
                      <label className="rename-field">
                        <span>New SRT name</span>
                        <input
                          type="text"
                          value={currentRenameSuggestion.editedSubtitleName}
                          onChange={(event) =>
                            updateRenameSuggestion(
                              currentRenameSuggestion.video.path,
                              'editedSubtitleName',
                              event.target.value
                            )
                          }
                        />
                      </label>
                    </article>
                  </div>

                  <div className="rename-actions">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={handleSkipRenameSuggestion}
                      disabled={actionLoading}
                    >
                      Skip
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      onClick={handleApplyCurrentRenameSuggestion}
                      disabled={actionLoading}
                    >
                      Apply Rename
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        )}

        {playerItem && (
          <div className="rename-modal-backdrop" onClick={() => setPlayerItem(null)}>
            <section className="glass-panel player-modal" onClick={(event) => event.stopPropagation()}>
              <div className="rename-panel-header">
                <div>
                  <p className="eyebrow">Movie Player</p>
                  <h2>{playerItem.name}</h2>
                </div>
                <button className="button subtle-button" type="button" onClick={() => setPlayerItem(null)}>
                  Close
                </button>
              </div>
              <video
                className="player-video"
                controls
                autoPlay
                src={`/api/files/show?path=${encodeURIComponent(playerItem.path)}`}
              />
            </section>
          </div>
        )}

        {!passwordSetupLoading && passwordSetupRequired && (
          <div className="rename-modal-backdrop password-setup-backdrop">
            <section className="glass-panel rename-modal password-setup-modal" onClick={(event) => event.stopPropagation()}>
              <div className="rename-panel-header">
                <div>
                  <p className="eyebrow">Security Setup</p>
                  <h2>Replace the default password</h2>
                  <p className="subtle">
                    This install is still using <code>change-me</code>. Set a real password before using the app.
                  </p>
                </div>
              </div>

              <form className="password-setup-form" onSubmit={handlePasswordSetupSubmit}>
                <label className="rename-field">
                  <span>New password</span>
                  <input
                    type="password"
                    value={passwordSetupPassword}
                    onChange={(event) => setPasswordSetupPassword(event.target.value)}
                    autoComplete="new-password"
                    disabled={passwordSetupSubmitting}
                  />
                </label>
                <label className="rename-field">
                  <span>Confirm password</span>
                  <input
                    type="password"
                    value={passwordSetupConfirm}
                    onChange={(event) => setPasswordSetupConfirm(event.target.value)}
                    autoComplete="new-password"
                    disabled={passwordSetupSubmitting}
                  />
                </label>

                <div className="password-setup-note">
                  After saving, the page will reload and your browser will ask you to sign in again with the new password.
                </div>

                <div className="rename-actions">
                  <button className="button primary" type="submit" disabled={passwordSetupSubmitting}>
                    {passwordSetupSubmitting ? 'Saving...' : 'Save New Password'}
                  </button>
                </div>
              </form>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(<App />);
