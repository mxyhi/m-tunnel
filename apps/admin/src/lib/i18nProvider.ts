import defaultMessages from "ra-language-english";
import polyglotI18nProvider from "ra-i18n-polyglot";

const messages = {
  ...defaultMessages,
  ra: {
    ...defaultMessages.ra,
    action: {
      ...defaultMessages.ra.action,
      add_filter: "添加筛选", add: "添加", back: "返回", bulk_actions: "已选择 %{smart_count} 项",
      cancel: "取消", clear_input_value: "清空", confirm: "确认", create: "创建", delete: "删除", edit: "编辑",
      export: "导出", list: "列表", refresh: "刷新", remove_filter: "移除筛选", remove_all_filters: "清除筛选",
      remove: "移除", reset: "重置", save: "保存", search: "搜索", search_columns: "搜索列", select_all: "全选",
      select_all_button: "全选", select_row: "选择此行", show: "查看", sort: "排序", undo: "撤销", unselect: "取消选择",
      expand: "展开", close: "关闭", open_menu: "打开菜单", close_menu: "关闭菜单", update: "更新",
      move_up: "上移", move_down: "下移", open: "打开", toggle_theme: "切换主题", select_columns: "显示列", update_application: "重新加载",
    },
    boolean: { true: "是", false: "否", null: "—" },
    page: {
      ...defaultMessages.ra.page,
      create: "创建%{name}", dashboard: "首页", edit: "%{name} %{recordRepresentation}", error: "出现错误",
      list: "%{name}", loading: "加载中", not_found: "页面不存在", show: "%{name} %{recordRepresentation}",
      empty: "暂无%{name}", invite: "可以使用创建按钮添加记录。", access_denied: "无权访问", authentication_error: "认证失败",
    },
    message: {
      ...defaultMessages.ra.message,
      access_denied: "你没有访问此页面的权限。", are_you_sure: "确定继续？", details: "详情", error: "请求失败，请重试。",
      invalid_form: "请检查表单内容。", loading: "请稍候", no: "否", yes: "是", not_found: "请检查页面地址。",
      unsaved_changes: "有尚未保存的修改，确定离开？", placeholder_data_warning: "网络异常，数据刷新失败。",
      authentication_error: "无法验证登录信息，请重试。", auth_error: "登录验证失败。",
    },
    navigation: {
      ...defaultMessages.ra.navigation,
      clear_filters: "清除筛选", no_filtered_results: "没有符合条件的%{name}", no_results: "暂无%{name}",
      page_range_info: "%{offsetBegin}–%{offsetEnd} / 共 %{total} 条", current_page: "第 %{page} 页", page: "第 %{page} 页",
      first: "首页", last: "末页", next: "下一页", previous: "上一页", page_rows_per_page: "每页条数", skip_nav: "跳至内容",
    },
    sort: { sort_by: "按%{field_lower_first}%{order}", ASC: "升序", DESC: "降序" },
    auth: {
      auth_check_error: "请先登录", user_menu: "账号菜单", username: "用户名", password: "密码", email: "邮箱",
      sign_in: "登录", sign_in_error: "登录失败，请检查邮箱和密码", logout: "退出登录",
    },
    notification: {
      ...defaultMessages.ra.notification,
      updated: "已更新", created: "已创建", deleted: "已删除", bad_item: "记录无效", item_doesnt_exist: "记录不存在",
      http_error: "服务器通信失败", data_provider_error: "数据请求失败", canceled: "已取消", logged_out: "会话已结束，请重新登录",
      not_authorized: "没有访问权限", offline: "网络连接不可用", application_update_available: "有新版本可用",
    },
    validation: { ...defaultMessages.ra.validation, required: "必填", email: "请输入有效邮箱", minLength: "至少 %{min} 个字符" },
  },
};
export const i18nProvider = polyglotI18nProvider(() => messages, "zh-CN", [{ name: "zh-CN", value: "简体中文" }], { allowMissing: true });
