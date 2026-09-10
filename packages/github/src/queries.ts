/** cards applies the project filter; assignedTotal omits it to count excluded assigned issues. */
/**
 * Shared card fields: five closing PRs bound cost (M48), statusCheckRollup feeds triage, $status names the status
 * field, and the project's field(name:) lookup tells a missing or differently typed field from an unset value.
 */
const ISSUE_FIELDS = `
  number title url state updatedAt
  issueType{ name color }
  repository{ nameWithOwner }
  author{ login avatarUrl(size:40) }
  assignees(first:10){ nodes{ login avatarUrl(size:40) } }
  pullRequests: closedByPullRequestsReferences(first:5){ nodes{
    number url state updatedAt isDraft reviewDecision
    author{ login avatarUrl(size:40) }
    commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } }
  }}
  projectItems(first:20){ nodes{
    project{ number owner{ ... on Organization{ login } ... on User{ login } } field(name:$status){ __typename } }
    fieldValueByName(name:$status){ ... on ProjectV2ItemFieldSingleSelectValue{ name color updatedAt } }
  }}`;

export const ASSIGNED_ISSUES_QUERY = `
query($cards:String!, $all:String!, $status:String!, $after:String){
  cards: search(query:$cards, type:ISSUE, first:100, after:$after){
    issueCount
    pageInfo{ hasNextPage endCursor }
    nodes{ ... on Issue{${ISSUE_FIELDS}
    }}
  }
  assignedTotal: search(query:$all, type:ISSUE, first:1){ issueCount }
}`;

/** Read issues absent from the assigned search with the same card fields. */
export const ISSUE_BY_NUMBER_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $status:String!){
  repository(owner:$owner, name:$name){
    issue(number:$number){${ISSUE_FIELDS}
    }
  }
}`;

/**
 * Read one conversation for display. `bodyHTML` is GitHub's own render, so no client parses markdown. The timeline
 * carries comments, reviews, commits, and every state change in one ordered list; both connections page.
 */
const ITEM_FIELDS = `
  number title url state createdAt bodyHTML lastEditedAt
  author{ ...who }
  ...reacted
  assignees(first:10){ nodes{ login } }
  milestone{ title }
  labels(first:50){ nodes{ name color } }`;

/** Events both subjects can report. GraphQL has no common timeline interface, so each union repeats them. */
const SHARED_EVENTS = `
  ... on IssueComment{ createdAt lastEditedAt isMinimized minimizedReason bodyHTML author{ ...who } ...reacted }
  ... on ClosedEvent{ createdAt actor{ ...who } stateReason }
  ... on ReopenedEvent{ createdAt actor{ ...who } }
  ... on LabeledEvent{ createdAt actor{ ...who } label{ name } }
  ... on UnlabeledEvent{ createdAt actor{ ...who } label{ name } }
  ... on AssignedEvent{ createdAt actor{ ...who } assignee{ ...assigned } }
  ... on UnassignedEvent{ createdAt actor{ ...who } assignee{ ...assigned } }
  ... on MilestonedEvent{ createdAt actor{ ...who } milestoneTitle }
  ... on DemilestonedEvent{ createdAt actor{ ...who } milestoneTitle }
  ... on RenamedTitleEvent{ createdAt actor{ ...who } previousTitle currentTitle }
  ... on CrossReferencedEvent{ createdAt actor{ ...who } source{ ...referenced } }
  ... on ReferencedEvent{ createdAt actor{ ...who } commit{ abbreviatedOid } }
  ... on LockedEvent{ createdAt actor{ ...who } lockReason }
  ... on UnlockedEvent{ createdAt actor{ ...who } }
  ... on MarkedAsDuplicateEvent{ createdAt actor{ ...who } canonical{ ...referenced } }
  ... on UnmarkedAsDuplicateEvent{ createdAt actor{ ...who } }`;

const SHARED_TYPES = `ISSUE_COMMENT, CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT,
  UNASSIGNED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT,
  REFERENCED_EVENT, LOCKED_EVENT, UNLOCKED_EVENT, MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT`;

/** Linking, transfer, and project-status changes. Both unions accept these, so both subjects report them. */
const LINKING_TYPES = `PROJECT_V2_ITEM_STATUS_CHANGED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT, TRANSFERRED_EVENT`;

const ISSUE_TYPES = `${SHARED_TYPES}, ${LINKING_TYPES}`;

const PR_TYPES = `${SHARED_TYPES}, ${LINKING_TYPES}, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT, MERGED_EVENT, REVIEW_REQUESTED_EVENT,
  REVIEW_REQUEST_REMOVED_EVENT, REVIEW_DISMISSED_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, HEAD_REF_DELETED_EVENT,
  HEAD_REF_RESTORED_EVENT, BASE_REF_CHANGED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT`;

/**
 * Page backwards, newest first: a read that stops early must drop the oldest entries, never the latest ones.
 * `hasPreviousPage` is the only clipping signal, because `totalCount` counts entries the connection never returns.
 */
const EVENT_PAGE = `
  pageInfo{ hasPreviousPage startCursor }`;

/** Replies within one thread, newest last, with the same backwards paging and the same clipping signal. */
const THREAD_COMMENTS = `
  comments(last:100){
    pageInfo{ hasPreviousPage }
    nodes{
      bodyHTML createdAt lastEditedAt isMinimized minimizedReason
      author{ ...who } ...reacted pullRequestReview{ id }
    }
  }`;

/** Fragments the timeline queries share. A document must spread every fragment it defines, so they travel together. */
const WHO_FRAGMENTS = `
fragment who on Actor{ login avatarUrl(size:40) }

fragment reacted on Reactable{ reactionGroups{ content reactors{ totalCount } } }`;

/** Events both unions accept that name another item or repository. */
const LINKING_EVENTS = `
  ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ ...who } previousStatus status }
  ... on ConnectedEvent{ createdAt actor{ ...who } subject{ ...referenced } }
  ... on DisconnectedEvent{ createdAt actor{ ...who } subject{ ...referenced } }
  ... on TransferredEvent{ createdAt actor{ ...who } fromRepository{ nameWithOwner } }`;

const EVENT_FRAGMENTS = `${WHO_FRAGMENTS}

fragment assigned on Assignee{ ... on User{ login } ... on Bot{ login } }

fragment referenced on ReferencedSubject{
  ... on Issue{ number url repository{ nameWithOwner } }
  ... on PullRequest{ number url repository{ nameWithOwner } }
}

fragment issueEvent on IssueTimelineItems{
  __typename${SHARED_EVENTS}${LINKING_EVENTS}
}

fragment prEvent on PullRequestTimelineItems{
  __typename${SHARED_EVENTS}${LINKING_EVENTS}
  ... on PullRequestReview{ id createdAt lastEditedAt state bodyHTML author{ ...who } ...reacted }
  ... on PullRequestCommit{ commit{ abbreviatedOid messageHeadline committedDate author{ user{ login } name } } }
  ... on MergedEvent{ createdAt actor{ ...who } mergeRefName }
  ... on ReviewRequestedEvent{ createdAt actor{ ...who } requestedReviewer{ ...reviewer } }
  ... on ReviewRequestRemovedEvent{ createdAt actor{ ...who } requestedReviewer{ ...reviewer } }
  ... on ReviewDismissedEvent{ createdAt actor{ ...who } dismissalMessage }
  ... on HeadRefForcePushedEvent{ createdAt actor{ ...who } beforeCommit{ abbreviatedOid } afterCommit{ abbreviatedOid } }
  ... on HeadRefDeletedEvent{ createdAt actor{ ...who } headRefName }
  ... on HeadRefRestoredEvent{ createdAt actor{ ...who } }
  ... on BaseRefChangedEvent{ createdAt actor{ ...who } previousRefName currentRefName }
  ... on ReadyForReviewEvent{ createdAt actor{ ...who } }
  ... on ConvertToDraftEvent{ createdAt actor{ ...who } }
}

fragment reviewer on RequestedReviewer{ ... on User{ login } ... on Team{ slug } ... on Bot{ login } }`;

export const DETAIL_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $issue:Boolean!, $pr:Boolean!, $events:String, $threads:String){
  repository(owner:$owner, name:$name){
    nameWithOwner
    issue(number:$number) @include(if:$issue){${ITEM_FIELDS}
      timelineItems(last:100, before:$events, itemTypes:[${ISSUE_TYPES}]){${EVENT_PAGE}
        nodes{ ...issueEvent }
      }
    }
    pullRequest(number:$number) @include(if:$pr){${ITEM_FIELDS}
      isDraft reviewDecision baseRefName headRefName
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      timelineItems(last:100, before:$events, itemTypes:[${PR_TYPES}]){${EVENT_PAGE}
        nodes{ ...prEvent }
      }
      reviewThreads(last:100, before:$threads){${EVENT_PAGE}
        nodes{
          path line originalLine isResolved isOutdated${THREAD_COMMENTS}
        }
      }
    }
  }
}
${EVENT_FRAGMENTS}`;

/** Page the timeline once the first read finds more. Threads are paged separately, so a page never refetches them. */
export const DETAIL_EVENTS_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $issue:Boolean!, $pr:Boolean!, $events:String){
  repository(owner:$owner, name:$name){
    issue(number:$number) @include(if:$issue){
      timelineItems(last:100, before:$events, itemTypes:[${ISSUE_TYPES}]){${EVENT_PAGE}
        nodes{ ...issueEvent }
      }
    }
    pullRequest(number:$number) @include(if:$pr){
      timelineItems(last:100, before:$events, itemTypes:[${PR_TYPES}]){${EVENT_PAGE}
        nodes{ ...prEvent }
      }
    }
  }
}
${EVENT_FRAGMENTS}`;

export const DETAIL_THREADS_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $threads:String){
  repository(owner:$owner, name:$name){
    pullRequest(number:$number){
      reviewThreads(last:100, before:$threads){${EVENT_PAGE}
        nodes{
          path line originalLine isResolved isOutdated${THREAD_COMMENTS}
        }
      }
    }
  }
}
${WHO_FRAGMENTS}`;

/**
 * Fetch issue and selected-PR context together for triage. Timeline events identify status and assignment
 * instructions (mechanics M32); reviews and requests determine ownership and review round. User profile fields
 * do not resolve for bots. Default/base branches and head OID support fresh action authorization; mergeability
 * does not establish a merge request (R39).
 */
export const CARD_CONTEXT_QUERY = `
query($owner:String!, $name:String!, $issue:Int!, $pr:Int!, $withPr:Boolean!){
  repository(owner:$owner, name:$name){
    defaultBranchRef{ name }
    issue(number:$issue){
      number title body
      comments(last:5){ nodes{ body createdAt authorAssociation author{ login ...profile } } }
      timelineItems(last:100, itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){ nodes{
        __typename
        ... on AssignedEvent{ createdAt actor{ login ...profile } assignee{ ... on User{ login } } }
        ... on UnassignedEvent{ createdAt actor{ login ...profile } assignee{ ... on User{ login } } }
        ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ login ...profile } previousStatus status project{ number owner{ ... on Organization{ login } ... on User{ login } } } }
      }}
    }
    pullRequest(number:$pr) @include(if:$withPr){
      number title body state isDraft
      author{ login ...profile }
      baseRefName headRefName
      commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state } } } }
      comments(last:5){ nodes{ body createdAt authorAssociation author{ login ...profile } } }
      reviews(last:20){ nodes{ state submittedAt author{ login ...profile } } }
      reviewRequests(first:10){ nodes{ requestedReviewer{
        ... on User{ login name }
        ... on Team{ slug }
      }}}
      reviewThreads(last:5){ nodes{
        isResolved isOutdated
        comments(first:3){ nodes{ body createdAt authorAssociation author{ login ...profile } } }
      }}
    }
  }
}

fragment profile on User{ name }`;
