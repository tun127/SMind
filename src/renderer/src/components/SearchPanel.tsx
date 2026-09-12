import { useMemo, type ReactElement } from 'react'
import { ArrowRight, BarChart3, Filter, Search, X } from 'lucide-react'
import { activeSheet, findTopic } from '@shared/model/tree'
import {
  applyTopicFilter,
  collectLabels,
  isFilterActive,
  searchSheet,
  sheetStats,
  type SearchField
} from '@shared/search'
import { MARKER_GROUPS } from '../render/markers'
import { viewportActions } from '../render/viewport'
import { useEditor } from '../store/editor'
import MarkerIcon from './MarkerIcon'

interface Props {
  onClose(): void
  onNotify(message: string): void
}

const FIELD_LABELS: Record<SearchField, string> = {
  title: '标题',
  notes: '备注',
  label: '标签'
}

export default function SearchPanel({ onClose, onNotify }: Props): ReactElement {
  const workbook = useEditor((s) => s.workbook)
  const search = useEditor((s) => s.search)
  const filter = useEditor((s) => s.filter)
  const selection = useEditor((s) => s.selection)
  const setSearchQuery = useEditor((s) => s.setSearchQuery)
  const setSearchReplacement = useEditor((s) => s.setSearchReplacement)
  const setSearchOption = useEditor((s) => s.setSearchOption)
  const resetSearch = useEditor((s) => s.resetSearch)
  const replaceAllInTitles = useEditor((s) => s.replaceAllInTitles)
  const replaceInTopic = useEditor((s) => s.replaceInTopic)
  const toggleFilterMarker = useEditor((s) => s.toggleFilterMarker)
  const toggleFilterLabel = useEditor((s) => s.toggleFilterLabel)
  const clearFilter = useEditor((s) => s.clearFilter)

  const sheet = useMemo(() => activeSheet(workbook), [workbook])

  // 与画布用同一份条件算命中，保证列表与高亮一致
  const hits = useMemo(
    () => (search.query.trim().length > 0 ? searchSheet(sheet, search.query, search.options) : []),
    [sheet, search.query, search.options]
  )
  const hitTotal = hits.reduce((sum, hit) => sum + hit.count, 0)
  const stats = useMemo(() => sheetStats(sheet), [sheet])
  const labels = useMemo(() => collectLabels(workbook), [workbook])
  const filterResult = useMemo(
    () => (isFilterActive(filter) ? applyTopicFilter(sheet.rootTopic, filter) : null),
    [sheet, filter]
  )

  const selectedId = selection[0] ?? null

  const goTo = (topicId: string): void => {
    useEditor.getState().select(topicId)
    // 命中的节点可能在别的画布上，先切过去再居中
    const owner = workbook.sheets.find((item) => findTopic(item.rootTopic, topicId))
    if (owner && owner.id !== workbook.activeSheetId) useEditor.getState().setActiveSheet(owner.id)
    window.requestAnimationFrame(() => viewportActions.centerOn(topicId))
  }

  const doReplaceAll = (): void => {
    if (search.query.trim().length === 0) {
      onNotify('请先输入要查找的内容')
      return
    }
    const count = replaceAllInTitles()
    onNotify(count > 0 ? `已替换 ${count} 处（仅标题）` : '标题里没有找到要替换的内容')
  }

  const doReplaceOne = (topicId: string): void => {
    const count = replaceInTopic(topicId)
    onNotify(count > 0 ? `已替换 ${count} 处` : '这个节点里没有可替换的内容')
  }

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <span>搜索 / 筛选 / 统计</span>
        <button type="button" className="tool-btn" title="关闭" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="side-panel__body">
        {/* ---------------- 搜索 ---------------- */}
        <div className="side-panel__title">
          <Search size={12} /> 全局搜索
        </div>
        <div className="side-panel__row">
          <input
            className="input"
            placeholder="搜索主题文字…"
            value={search.query}
            autoFocus
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {search.query.length > 0 && (
            <button
              type="button"
              className="btn"
              title="清空搜索"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => resetSearch()}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="search-options">
          <label className="search-option">
            <input
              type="checkbox"
              checked={search.options.caseSensitive}
              onChange={(e) => setSearchOption('caseSensitive', e.target.checked)}
            />
            区分大小写
          </label>
          <label className="search-option">
            <input
              type="checkbox"
              checked={search.options.inNotes}
              onChange={(e) => setSearchOption('inNotes', e.target.checked)}
            />
            包含备注
          </label>
          <label className="search-option">
            <input
              type="checkbox"
              checked={search.options.inLabels}
              onChange={(e) => setSearchOption('inLabels', e.target.checked)}
            />
            包含标签
          </label>
        </div>

        {search.query.trim().length > 0 && (
          <div className="side-panel__hint">
            找到 <b>{hits.length}</b> 个主题、共 <b>{hitTotal}</b> 处命中（当前画布）
          </div>
        )}

        {hits.length > 0 && (
          <div className="search-results">
            {hits.map((hit) => (
              <div
                key={`${hit.topicId}-${hit.field}`}
                className={hit.topicId === selectedId ? 'search-hit search-hit--active' : 'search-hit'}
              >
                <button
                  type="button"
                  className="search-hit__main"
                  title="跳转并居中显示这个主题"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => goTo(hit.topicId)}
                >
                  <span className="search-hit__title">{hit.title || '（空主题）'}</span>
                  <span className="search-hit__snippet">
                    <span className="search-hit__field">{FIELD_LABELS[hit.field]}</span>
                    {hit.snippet}
                  </span>
                </button>
                <button
                  type="button"
                  className="search-hit__replace"
                  title={`在这个主题里替换 ${hit.count} 处`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => doReplaceOne(hit.topicId)}
                >
                  <ArrowRight size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ---------------- 替换 ---------------- */}
        <div className="side-panel__title side-panel__title--sub">替换</div>
        <div className="side-panel__row">
          <input
            className="input"
            placeholder="替换为…"
            value={search.replacement}
            onChange={(event) => setSearchReplacement(event.target.value)}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={search.query.trim().length === 0}
            onMouseDown={(e) => e.preventDefault()}
            onClick={doReplaceAll}
          >
            全部替换
          </button>
        </div>
        <div className="side-panel__hint">
          「全部替换」作用于<b>当前画布</b>所有主题的<b>标题</b>；备注与标签只参与搜索、不会被替换。
          带局部格式（加粗/变色）的标题被替换后会退化为纯文本。
        </div>

        {/* ---------------- 筛选 ---------------- */}
        <div className="side-panel__title side-panel__title--sub">
          <Filter size={12} /> 按标记 / 标签筛选
        </div>
        <div className="side-panel__hint">
          选中的标记之间是「或」，标记与标签之间是「且」。
          {filterResult && (
            <>
              {' '}
              当前命中 <b>{filterResult.hits.size}</b> 个主题，未命中的会淡出显示。
            </>
          )}
        </div>

        {MARKER_GROUPS.map((group) => (
          <div key={group.title} className="marker-row">
            <span className="marker-row__label">{group.title}</span>
            <div className="marker-picker">
              {group.markers.map((markerId) => {
                const active = filter.markers.includes(markerId)
                return (
                  <button
                    key={markerId}
                    type="button"
                    className={active ? 'marker-btn marker-btn--active' : 'marker-btn'}
                    title={`按「${markerId}」筛选`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleFilterMarker(markerId)}
                  >
                    <MarkerIcon markerId={markerId} />
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        <div className="side-panel__title side-panel__title--sub">按标签筛选</div>
        {labels.length === 0 ? (
          <div className="side-panel__hint">这份文件里还没有标签。</div>
        ) : (
          <div className="chip-row">
            {labels.map((item) => {
              const active = filter.labels.includes(item.label)
              return (
                <button
                  key={item.label}
                  type="button"
                  className={active ? 'chip chip--toggle chip--active' : 'chip chip--toggle'}
                  title={`${item.count} 个主题带这个标签`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleFilterLabel(item.label)}
                >
                  <span className="chip__text">{item.label}</span>
                  <span className="chip__count">{item.count}</span>
                </button>
              )
            })}
          </div>
        )}

        {(filter.markers.length > 0 || filter.labels.length > 0) && (
          <div className="side-panel__row">
            <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={clearFilter}>
              <X size={14} />
              清除筛选
            </button>
          </div>
        )}

        {/* ---------------- 统计 ---------------- */}
        <div className="side-panel__title side-panel__title--sub">
          <BarChart3 size={12} /> 当前画布统计
        </div>
        <div className="stats-grid">
          <div className="stats-cell">
            <span className="stats-cell__value">{stats.topics}</span>
            <span className="stats-cell__label">主题总数</span>
          </div>
          <div className="stats-cell">
            <span className="stats-cell__value">{stats.characters}</span>
            <span className="stats-cell__label">标题字数</span>
          </div>
          <div className="stats-cell">
            <span className="stats-cell__value">{stats.maxDepth + 1}</span>
            <span className="stats-cell__label">最大层级</span>
          </div>
          <div className="stats-cell">
            <span className="stats-cell__value">{stats.leaves}</span>
            <span className="stats-cell__label">叶子主题</span>
          </div>
        </div>

        <div className="stats-lines">
          <div>
            含备注 <b>{stats.withNotes}</b> · 含附件 <b>{stats.withAttachments}</b> · 含图片{' '}
            <b>{stats.withImages}</b> · 含公式 <b>{stats.withFormulas}</b>
          </div>
          <div>
            全工作簿 <b>{workbook.sheets.length}</b> 张画布
          </div>
        </div>

        {stats.markers.length > 0 && (
          <>
            <div className="side-panel__title side-panel__title--sub">标记分布</div>
            <div className="stats-list">
              {stats.markers.map((item) => (
                <button
                  key={item.markerId}
                  type="button"
                  className="stats-row"
                  title={`按「${item.markerId}」筛选`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleFilterMarker(item.markerId)}
                >
                  <MarkerIcon markerId={item.markerId} size={13} />
                  <span className="stats-row__name">{item.markerId}</span>
                  <span className="stats-row__count">{item.count}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {stats.labels.length > 0 && (
          <>
            <div className="side-panel__title side-panel__title--sub">标签分布</div>
            <div className="stats-list">
              {stats.labels.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="stats-row"
                  title={`按「${item.label}」筛选`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleFilterLabel(item.label)}
                >
                  <span className="stats-row__name">{item.label}</span>
                  <span className="stats-row__count">{item.count}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
